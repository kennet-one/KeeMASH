[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [Environment]::Is64BitProcess) {
    throw 'This probe must run in a 64-bit PowerShell process.'
}

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class KeeMashNvapiThermalProbe
{
    private const int NvapiOk = 0;
    private const int MaxPhysicalGpus = 64;
    private const int MaxChannels = 32;
    private const uint NvapiInitializeId = 0x0150E828;
    private const uint NvapiEnumPhysicalGpusId = 0xE5AC921F;
    private const uint NvapiThermChannelGetInfoId = 0x0BC8163D;
    private const uint NvapiThermChannelGetStatusId = 0x65FE3AAD;

    [StructLayout(LayoutKind.Sequential)]
    private struct ThermalChannelInfo
    {
        public uint ChannelClass;
        public uint ChannelType;
        public uint RelativeLocation;
        public uint TargetGpu;
        public int Scaling;
        public int SoftwareOffset;
        public int MinimumTemperature;
        public int MaximumTemperature;
        public byte TemperatureSimulationSupported;
        public byte Flags;
        public int HardwareOffset;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 28)]
        public byte[] Reserved;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ThermalInfoParams
    {
        public uint Version;
        public uint ChannelMask;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
        public byte[] Reserved;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxChannels)]
        public ThermalChannelInfo[] Channels;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 5)]
        public byte[] PrimaryChannelIndex;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ThermalStatusParams
    {
        public uint Version;
        public uint ChannelMask;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
        public byte[] Reserved;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxChannels)]
        public int[] Channels;
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

    public sealed class Channel
    {
        public int GpuIndex { get; set; }
        public int ChannelIndex { get; set; }
        public uint ChannelClass { get; set; }
        public uint ChannelType { get; set; }
        public uint RelativeLocation { get; set; }
        public uint TargetGpu { get; set; }
        public int Scaling { get; set; }
        public int SoftwareOffset { get; set; }
        public int HardwareOffset { get; set; }
        public int MinimumRaw { get; set; }
        public int MaximumRaw { get; set; }
        public int Raw { get; set; }
        public double Celsius { get; set; }
        public bool IsPrimaryMemory { get; set; }
    }

    public sealed class Snapshot
    {
        public int InfoStructSize { get; set; }
        public int StatusStructSize { get; set; }
        public uint GpuCount { get; set; }
        public List<Channel> Channels { get; set; }
        public List<string> Diagnostics { get; set; }
    }

    private static T Delegate<T>(QueryInterface query, uint id) where T : class
    {
        IntPtr address = query(id);
        if (address == IntPtr.Zero)
            throw new InvalidOperationException(String.Format("NVAPI interface 0x{0:X8} is unavailable.", id));
        return Marshal.GetDelegateForFunctionPointer(address, typeof(T)) as T;
    }

    private static ThermalInfoParams CreateInfo()
    {
        ThermalInfoParams value = new ThermalInfoParams
        {
            Reserved = new byte[32],
            Channels = new ThermalChannelInfo[MaxChannels],
            PrimaryChannelIndex = new byte[5]
        };
        for (int index = 0; index < MaxChannels; index++)
        {
            value.Channels[index].Reserved = new byte[28];
            value.Channels[index].Data = new byte[16];
        }
        value.Version = (uint)(Marshal.SizeOf(typeof(ThermalInfoParams)) | (2 << 16));
        return value;
    }

    private static ThermalStatusParams CreateStatus(uint mask)
    {
        ThermalStatusParams value = new ThermalStatusParams
        {
            ChannelMask = mask,
            Reserved = new byte[32],
            Channels = new int[MaxChannels]
        };
        value.Version = (uint)(Marshal.SizeOf(typeof(ThermalStatusParams)) | (2 << 16));
        return value;
    }

    public static Snapshot Read()
    {
        IntPtr library = LoadLibraryW("nvapi64.dll");
        if (library == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "nvapi64.dll could not be loaded.");

        IntPtr queryAddress = GetProcAddress(library, "nvapi_QueryInterface");
        if (queryAddress == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "nvapi_QueryInterface was not exported.");

        QueryInterface query = (QueryInterface)Marshal.GetDelegateForFunctionPointer(queryAddress, typeof(QueryInterface));
        Initialize initialize = Delegate<Initialize>(query, NvapiInitializeId);
        EnumPhysicalGpus enumerate = Delegate<EnumPhysicalGpus>(query, NvapiEnumPhysicalGpusId);
        ThermChannelGetInfo getInfo = Delegate<ThermChannelGetInfo>(query, NvapiThermChannelGetInfoId);
        ThermChannelGetStatus getStatus = Delegate<ThermChannelGetStatus>(query, NvapiThermChannelGetStatusId);

        int result = initialize();
        if (result != NvapiOk)
            throw new InvalidOperationException("NvAPI_Initialize failed with status " + result + ".");

        IntPtr[] handles = new IntPtr[MaxPhysicalGpus];
        uint count;
        result = enumerate(handles, out count);
        if (result != NvapiOk)
            throw new InvalidOperationException("NvAPI_EnumPhysicalGPUs failed with status " + result + ".");

        Snapshot snapshot = new Snapshot
        {
            InfoStructSize = Marshal.SizeOf(typeof(ThermalInfoParams)),
            StatusStructSize = Marshal.SizeOf(typeof(ThermalStatusParams)),
            GpuCount = count,
            Channels = new List<Channel>(),
            Diagnostics = new List<string>()
        };

        for (int gpuIndex = 0; gpuIndex < count; gpuIndex++)
        {
            ThermalInfoParams info = CreateInfo();
            result = getInfo(handles[gpuIndex], ref info);
            if (result != NvapiOk)
            {
                snapshot.Diagnostics.Add("GPU " + gpuIndex + " info status " + result);
                continue;
            }

            ThermalStatusParams status = CreateStatus(info.ChannelMask);
            result = getStatus(handles[gpuIndex], ref status);
            if (result != NvapiOk)
            {
                snapshot.Diagnostics.Add("GPU " + gpuIndex + " status call returned " + result);
                continue;
            }

            int primaryMemory = info.PrimaryChannelIndex.Length > 3 ? info.PrimaryChannelIndex[3] : -1;
            for (int channelIndex = 0; channelIndex < MaxChannels; channelIndex++)
            {
                if ((info.ChannelMask & (1u << channelIndex)) == 0)
                    continue;

                ThermalChannelInfo channel = info.Channels[channelIndex];
                int raw = status.Channels[channelIndex];
                snapshot.Channels.Add(new Channel
                {
                    GpuIndex = gpuIndex,
                    ChannelIndex = channelIndex,
                    ChannelClass = channel.ChannelClass,
                    ChannelType = channel.ChannelType,
                    RelativeLocation = channel.RelativeLocation,
                    TargetGpu = channel.TargetGpu,
                    Scaling = channel.Scaling,
                    SoftwareOffset = channel.SoftwareOffset,
                    HardwareOffset = channel.HardwareOffset,
                    MinimumRaw = channel.MinimumTemperature,
                    MaximumRaw = channel.MaximumTemperature,
                    Raw = raw,
                    Celsius = raw / 256.0,
                    IsPrimaryMemory = channelIndex == primaryMemory
                });
            }
        }
        return snapshot;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$snapshot = [KeeMashNvapiThermalProbe]::Read()
$snapshot.Channels |
    Sort-Object GpuIndex, ChannelIndex |
    Select-Object GpuIndex, ChannelIndex, ChannelClass, ChannelType, RelativeLocation,
        TargetGpu, Scaling, Raw, Celsius, IsPrimaryMemory, MinimumRaw, MaximumRaw,
        SoftwareOffset, HardwareOffset |
    Format-Table -AutoSize |
    Out-String -Width 260 |
    Write-Output
$snapshot | Select-Object InfoStructSize, StatusStructSize, GpuCount, Diagnostics | Format-List
