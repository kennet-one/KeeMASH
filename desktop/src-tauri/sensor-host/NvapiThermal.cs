using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace KeeMash.SensorHost
{
    // Read-only private thermal-channel layouts exposed by the NVIDIA driver.
    // Unknown channel types remain unknown; they are never relabeled as VRAM chips.
    internal sealed class NvapiThermalChannelRecord
    {
        public int gpuIndex;
        public int channelIndex;
        public uint channelClass;
        public uint channelType;
        public uint relativeLocation;
        public uint targetGpu;
        public int raw;
        public float temperatureC;
        public bool primaryMemory;
    }

    internal static class NvapiThermalReader
    {
        private const int NvapiOk = 0;
        private const int MaxPhysicalGpus = 64;
        private const int MaxChannels = 32;
        private const int ThermalInfoParamsSize = 2736;
        private const int ThermalStatusParamsSize = 168;
        private const uint NvapiInitializeId = 0x0150E828;
        private const uint NvapiEnumPhysicalGpusId = 0xE5AC921F;
        private const uint NvapiThermChannelGetInfoId = 0x0BC8163D;
        private const uint NvapiThermChannelGetStatusId = 0x65FE3AAD;

        private static readonly object Sync = new object();
        private static bool _initializationAttempted;
        private static string _initializationError = string.Empty;
        private static IntPtr[] _gpuHandles = new IntPtr[0];
        private static ThermChannelGetInfo _getInfo;
        private static ThermChannelGetStatus _getStatus;

        [StructLayout(LayoutKind.Sequential)]
        private struct ThermalChannelInfo
        {
            public uint channelClass;
            public uint channelType;
            public uint relativeLocation;
            public uint targetGpu;
            public int scaling;
            public int softwareOffset;
            public int minimumTemperature;
            public int maximumTemperature;
            public byte temperatureSimulationSupported;
            public byte flags;
            public int hardwareOffset;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 28)]
            public byte[] reserved;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
            public byte[] data;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ThermalInfoParams
        {
            public uint version;
            public uint channelMask;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
            public byte[] reserved;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxChannels)]
            public ThermalChannelInfo[] channels;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 5)]
            public byte[] primaryChannelIndex;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ThermalStatusParams
        {
            public uint version;
            public uint channelMask;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
            public byte[] reserved;

            [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxChannels)]
            public int[] channels;
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr QueryInterface(uint interfaceId);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int Initialize();

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int EnumPhysicalGpus([Out] IntPtr[] handles, out uint count);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int ThermChannelGetInfo(IntPtr gpu, ref ThermalInfoParams info);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int ThermChannelGetStatus(IntPtr gpu, ref ThermalStatusParams status);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryW(string fileName);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr module, string name);

        internal static List<NvapiThermalChannelRecord> Read(out string error)
        {
            lock (Sync)
            {
                EnsureInitialized();
                if (!string.IsNullOrEmpty(_initializationError))
                {
                    error = _initializationError;
                    return new List<NvapiThermalChannelRecord>();
                }

                List<NvapiThermalChannelRecord> result = new List<NvapiThermalChannelRecord>();
                List<string> failures = new List<string>();
                for (int gpuIndex = 0; gpuIndex < _gpuHandles.Length; gpuIndex++)
                {
                    ThermalInfoParams info = CreateInfo();
                    int status = _getInfo(_gpuHandles[gpuIndex], ref info);
                    if (status != NvapiOk)
                    {
                        failures.Add("GPU " + gpuIndex + " info status " + status);
                        continue;
                    }

                    ThermalStatusParams temperatures = CreateStatus(info.channelMask);
                    status = _getStatus(_gpuHandles[gpuIndex], ref temperatures);
                    if (status != NvapiOk)
                    {
                        failures.Add("GPU " + gpuIndex + " status " + status);
                        continue;
                    }

                    int primaryMemory = info.primaryChannelIndex.Length > 3
                        ? info.primaryChannelIndex[3]
                        : -1;
                    for (int channelIndex = 0; channelIndex < MaxChannels; channelIndex++)
                    {
                        if ((info.channelMask & (1u << channelIndex)) == 0)
                        {
                            continue;
                        }

                        int raw = temperatures.channels[channelIndex];
                        float celsius = raw / 256.0f;
                        if (float.IsNaN(celsius) || float.IsInfinity(celsius) || celsius < -50.0f || celsius > 200.0f)
                        {
                            continue;
                        }

                        ThermalChannelInfo channel = info.channels[channelIndex];
                        result.Add(new NvapiThermalChannelRecord
                        {
                            gpuIndex = gpuIndex,
                            channelIndex = channelIndex,
                            channelClass = channel.channelClass,
                            channelType = channel.channelType,
                            relativeLocation = channel.relativeLocation,
                            targetGpu = channel.targetGpu,
                            raw = raw,
                            temperatureC = celsius,
                            primaryMemory = channelIndex == primaryMemory
                        });
                    }
                }

                error = failures.Count == 0 ? string.Empty : string.Join("; ", failures.ToArray());
                return result;
            }
        }

        private static void EnsureInitialized()
        {
            if (_initializationAttempted)
            {
                return;
            }
            _initializationAttempted = true;

            try
            {
                ValidateLayouts();
                IntPtr library = LoadLibraryW("nvapi64.dll");
                if (library == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "nvapi64.dll could not be loaded");
                }

                IntPtr queryAddress = GetProcAddress(library, "nvapi_QueryInterface");
                if (queryAddress == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "nvapi_QueryInterface is unavailable");
                }

                QueryInterface query = (QueryInterface)Marshal.GetDelegateForFunctionPointer(queryAddress, typeof(QueryInterface));
                Initialize initialize = Resolve<Initialize>(query, NvapiInitializeId);
                EnumPhysicalGpus enumerate = Resolve<EnumPhysicalGpus>(query, NvapiEnumPhysicalGpusId);
                _getInfo = Resolve<ThermChannelGetInfo>(query, NvapiThermChannelGetInfoId);
                _getStatus = Resolve<ThermChannelGetStatus>(query, NvapiThermChannelGetStatusId);

                int status = initialize();
                if (status != NvapiOk)
                {
                    throw new InvalidOperationException("NvAPI_Initialize status " + status);
                }

                IntPtr[] handles = new IntPtr[MaxPhysicalGpus];
                uint count;
                status = enumerate(handles, out count);
                if (status != NvapiOk)
                {
                    throw new InvalidOperationException("NvAPI_EnumPhysicalGPUs status " + status);
                }
                if (count > MaxPhysicalGpus)
                {
                    throw new InvalidOperationException("NvAPI returned an invalid GPU count " + count);
                }

                _gpuHandles = new IntPtr[count];
                Array.Copy(handles, _gpuHandles, (int)count);
            }
            catch (Exception exception)
            {
                _initializationError = exception.GetType().Name + ": " + exception.Message;
                _gpuHandles = new IntPtr[0];
            }
        }

        private static void ValidateLayouts()
        {
            int infoSize = Marshal.SizeOf(typeof(ThermalInfoParams));
            int statusSize = Marshal.SizeOf(typeof(ThermalStatusParams));
            if (infoSize != ThermalInfoParamsSize || statusSize != ThermalStatusParamsSize)
            {
                throw new InvalidOperationException(
                    "Unexpected NVAPI thermal layouts: info=" + infoSize + ", status=" + statusSize);
            }
        }

        private static T Resolve<T>(QueryInterface query, uint interfaceId) where T : class
        {
            IntPtr address = query(interfaceId);
            if (address == IntPtr.Zero)
            {
                throw new InvalidOperationException(string.Format("NVAPI interface 0x{0:X8} is unavailable", interfaceId));
            }
            return Marshal.GetDelegateForFunctionPointer(address, typeof(T)) as T;
        }

        private static ThermalInfoParams CreateInfo()
        {
            ThermalInfoParams value = new ThermalInfoParams
            {
                reserved = new byte[32],
                channels = new ThermalChannelInfo[MaxChannels],
                primaryChannelIndex = new byte[5]
            };
            for (int index = 0; index < MaxChannels; index++)
            {
                value.channels[index].reserved = new byte[28];
                value.channels[index].data = new byte[16];
            }
            value.version = (uint)(Marshal.SizeOf(typeof(ThermalInfoParams)) | (2 << 16));
            return value;
        }

        private static ThermalStatusParams CreateStatus(uint channelMask)
        {
            ThermalStatusParams value = new ThermalStatusParams
            {
                channelMask = channelMask,
                reserved = new byte[32],
                channels = new int[MaxChannels]
            };
            value.version = (uint)(Marshal.SizeOf(typeof(ThermalStatusParams)) | (2 << 16));
            return value;
        }
    }
}
