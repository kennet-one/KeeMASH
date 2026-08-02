using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Threading;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.PawnIo;
using RAMSPDToolkit.I2CSMBus;
using RAMSPDToolkit.SPD;
using RAMSPDToolkit.SPD.Enums;
using RAMSPDToolkit.SPD.Interop.Shared;
using RAMSPDToolkit.SPD.Timings;

namespace KeeMash.SensorHost
{
    internal sealed class SensorRecord
    {
        public string hardwareName;
        public string hardwareType;
        public string hardwareIdentifier;
        public string name;
        public string sensorType;
        public string identifier;
        public float value;
    }

    internal sealed class MemoryModuleRecord
    {
        public string slot;
        public string bank;
        public string name;
        public string manufacturer;
        public string partNumber;
        public string serialNumber;
        public ulong capacityBytes;
        public uint speedMts;
        public uint configuredSpeedMts;
        public uint configuredVoltageMv;
        public uint minVoltageMv;
        public uint maxVoltageMv;
        public uint dataWidthBits;
        public uint totalWidthBits;
        public string formFactor;
        public string memoryType;
    }

    internal sealed class MemoryTimingRecord
    {
        public string name;
        public string group;
        public int cycles;
        public decimal nanoseconds;
        public string source;
    }

    internal sealed class MemorySpdProfileRecord
    {
        public string address;
        public string memoryType;
        public string manufacturer;
        public string dramManufacturer;
        public string partNumber;
        public string serialNumber;
        public float capacityGiB;
        public uint dataRateMts;
        public List<int> casLatencies;
        public List<MemoryTimingRecord> timings;
    }

    internal sealed class SensorSnapshot
    {
        public long timestamp;
        public bool pawnIoInstalled;
        public List<SensorRecord> sensors;
        public List<NvapiThermalChannelRecord> nvapiThermalChannels;
        public string nvapiThermalError;
        public List<MemoryModuleRecord> memoryModules;
        public List<MemorySpdProfileRecord> memorySpdProfiles;
        public string memorySpdError;
    }

    internal sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer)
        {
            computer.Traverse(this);
        }

        public void VisitHardware(IHardware hardware)
        {
            hardware.Update();
            foreach (IHardware child in hardware.SubHardware)
            {
                child.Accept(this);
            }
        }

        public void VisitSensor(ISensor sensor) { }
        public void VisitParameter(IParameter parameter) { }
    }

    internal static class Program
    {
        private const int SampleIntervalMs = 2000;
        private static volatile bool _stopping;

        private static int Main(string[] args)
        {
            int parentPid = ParseParentPid(args);
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
            {
                eventArgs.Cancel = true;
                _stopping = true;
            };

            Computer computer = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsMemoryEnabled = true
            };

            try
            {
                computer.Open();
                UpdateVisitor visitor = new UpdateVisitor();
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                List<MemoryModuleRecord> memoryModules = ReadPhysicalMemory();
                string memorySpdError;
                List<MemorySpdProfileRecord> memorySpdProfiles = ReadSpdProfiles(out memorySpdError);

                while (!_stopping && ParentIsAlive(parentPid))
                {
                    computer.Accept(visitor);
                    string nvapiThermalError;
                    SensorSnapshot snapshot = new SensorSnapshot
                    {
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        pawnIoInstalled = PawnIo.IsInstalled,
                        sensors = ReadSensors(computer),
                        nvapiThermalChannels = NvapiThermalReader.Read(out nvapiThermalError),
                        nvapiThermalError = nvapiThermalError,
                        memoryModules = memoryModules,
                        memorySpdProfiles = memorySpdProfiles,
                        memorySpdError = memorySpdError
                    };
                    Console.WriteLine(serializer.Serialize(snapshot));
                    Console.Out.Flush();

                    for (int elapsed = 0; elapsed < SampleIntervalMs && !_stopping; elapsed += 100)
                    {
                        Thread.Sleep(100);
                    }
                }
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
                return 1;
            }
            finally
            {
                computer.Close();
            }
        }

        private static int ParseParentPid(string[] args)
        {
            for (int index = 0; index + 1 < args.Length; index++)
            {
                if (string.Equals(args[index], "--parent-pid", StringComparison.OrdinalIgnoreCase))
                {
                    int value;
                    if (int.TryParse(args[index + 1], NumberStyles.None, CultureInfo.InvariantCulture, out value))
                    {
                        return value;
                    }
                }
            }
            return 0;
        }

        private static bool ParentIsAlive(int parentPid)
        {
            if (parentPid <= 0)
            {
                return true;
            }

            try
            {
                Process process = Process.GetProcessById(parentPid);
                return !process.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private static List<SensorRecord> ReadSensors(IComputer computer)
        {
            List<SensorRecord> result = new List<SensorRecord>();
            foreach (IHardware hardware in computer.Hardware)
            {
                AddHardwareSensors(hardware, result);
            }
            return result;
        }

        private static void AddHardwareSensors(IHardware hardware, List<SensorRecord> result)
        {
            foreach (ISensor sensor in hardware.Sensors)
            {
                if (!sensor.Value.HasValue)
                {
                    continue;
                }

                float value = sensor.Value.Value;
                if (float.IsNaN(value) || float.IsInfinity(value))
                {
                    continue;
                }

                result.Add(new SensorRecord
                {
                    hardwareName = hardware.Name ?? string.Empty,
                    hardwareType = hardware.HardwareType.ToString(),
                    hardwareIdentifier = hardware.Identifier.ToString(),
                    name = sensor.Name ?? string.Empty,
                    sensorType = sensor.SensorType.ToString(),
                    identifier = sensor.Identifier.ToString(),
                    value = value
                });
            }

            foreach (IHardware child in hardware.SubHardware)
            {
                AddHardwareSensors(child, result);
            }
        }

        private static List<MemoryModuleRecord> ReadPhysicalMemory()
        {
            List<MemoryModuleRecord> modules = new List<MemoryModuleRecord>();
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "root\\CIMV2",
                    "SELECT DeviceLocator, BankLabel, Manufacturer, PartNumber, SerialNumber, Capacity, Speed, ConfiguredClockSpeed, ConfiguredVoltage, MinVoltage, MaxVoltage, DataWidth, TotalWidth, FormFactor, SMBIOSMemoryType FROM Win32_PhysicalMemory"))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    foreach (ManagementObject item in results)
                    {
                        string slot = Text(item["DeviceLocator"]);
                        string bank = Text(item["BankLabel"]);
                        string manufacturer = Text(item["Manufacturer"]);
                        string partNumber = Text(item["PartNumber"]);
                        string serialNumber = Text(item["SerialNumber"]);
                        ulong capacity = Number(item["Capacity"]);

                        modules.Add(new MemoryModuleRecord
                        {
                            slot = string.IsNullOrWhiteSpace(slot) ? bank : slot,
                            bank = bank,
                            name = JoinName(manufacturer, partNumber),
                            manufacturer = manufacturer,
                            partNumber = partNumber,
                            serialNumber = serialNumber,
                            capacityBytes = capacity,
                            speedMts = UIntNumber(item["Speed"]),
                            configuredSpeedMts = UIntNumber(item["ConfiguredClockSpeed"]),
                            configuredVoltageMv = UIntNumber(item["ConfiguredVoltage"]),
                            minVoltageMv = UIntNumber(item["MinVoltage"]),
                            maxVoltageMv = UIntNumber(item["MaxVoltage"]),
                            dataWidthBits = UIntNumber(item["DataWidth"]),
                            totalWidthBits = UIntNumber(item["TotalWidth"]),
                            formFactor = FormFactorName(UIntNumber(item["FormFactor"])),
                            memoryType = MemoryTypeName(UIntNumber(item["SMBIOSMemoryType"]))
                        });
                    }
                }
            }
            catch
            {
                // Temperature sensors can still be reported when CIM inventory is unavailable.
            }
            return modules;
        }

        private static List<MemorySpdProfileRecord> ReadSpdProfiles(out string errorText)
        {
            List<MemorySpdProfileRecord> profiles = new List<MemorySpdProfileRecord>();
            errorText = string.Empty;
            try
            {
                SMBusManager.DetectSMBuses();
                foreach (SMBusInterface bus in SMBusManager.RegisteredSMBuses)
                {
                    for (byte address = SPDConstants.SPD_BEGIN; address <= SPDConstants.SPD_END; address++)
                    {
                        SPDDetector detector = new SPDDetector(bus, address);
                        DDR4Accessor ddr4 = detector.Accessor as DDR4Accessor;
                        if (ddr4 == null)
                        {
                            continue;
                        }

                        DDR4Timings timings = ddr4.SDRAMTimings;
                        uint dataRate = DataRateFromCycleTime(timings.MinimumCycleTime);
                        decimal cycleTime = dataRate == 0 ? timings.MinimumCycleTime : 2000m / dataRate;
                        List<MemoryTimingRecord> values = new List<MemoryTimingRecord>();
                        AddTiming(values, "tCL", "primary", timings.MinimumCASLatencyTime, cycleTime, SelectCasLatency(timings, cycleTime));
                        AddTiming(values, "tRCD", "primary", timings.MinimumRASToCASDelayTime, cycleTime, 0);
                        AddTiming(values, "tRP", "primary", timings.MinimumRowPrechargeDelayTime, cycleTime, 0);
                        AddTiming(values, "tRAS", "primary", timings.MinimumActiveToPrechargeDelayTime, cycleTime, 0);
                        AddTiming(values, "tRC", "secondary", timings.MinimumActiveToActiveRefreshDelayTime, cycleTime, 0);
                        AddTiming(values, "tRFC1", "secondary", timings.MinimumRefreshRecoveryDelayTime1, cycleTime, 0);
                        AddTiming(values, "tRFC2", "secondary", timings.MinimumRefreshRecoveryDelayTime2, cycleTime, 0);
                        AddTiming(values, "tRFC4", "secondary", timings.MinimumRefreshRecoveryDelayTime4, cycleTime, 0);
                        AddTiming(values, "tFAW", "secondary", timings.MinimumFourActivateWindowTime, cycleTime, 0);
                        AddTiming(values, "tRRD_S", "secondary", timings.MinimumActivateToActivateDelay_DiffGroup, cycleTime, 0);
                        AddTiming(values, "tRRD_L", "secondary", timings.MinimumActivateToActivateDelay_SameGroup, cycleTime, 0);
                        AddTiming(values, "tCCD_L", "secondary", timings.MinimumCASToCASDelay_SameGroup, cycleTime, 0);
                        AddTiming(values, "tWR", "secondary", timings.MinimumWriteRecoveryTime, cycleTime, 0);
                        AddTiming(values, "tWTR_S", "secondary", timings.MinimumWriteToReadTime_DiffGroup, cycleTime, 0);
                        AddTiming(values, "tWTR_L", "secondary", timings.MinimumWriteToReadTime_SameGroup, cycleTime, 0);

                        ddr4.ChangePage(PageData.ModulePartNumber);
                        profiles.Add(new MemorySpdProfileRecord
                        {
                            address = string.Format(CultureInfo.InvariantCulture, "0x{0:X2}", detector.Address),
                            memoryType = detector.SPDMemoryType.ToString(),
                            manufacturer = ddr4.GetModuleManufacturerString(),
                            dramManufacturer = ddr4.GetDRAMManufacturerString(),
                            partNumber = ddr4.ModulePartNumber(),
                            serialNumber = ddr4.ModuleSerialNumber(),
                            capacityGiB = ddr4.GetCapacity(),
                            dataRateMts = dataRate,
                            casLatencies = timings.CASLatenciesSupported,
                            timings = values
                        });
                    }
                }
                if (profiles.Count == 0)
                {
                    errorText = SMBusManager.RegisteredSMBuses.Count == 0
                        ? "No SMBus provider exposed readable SPD devices"
                        : "SMBus detected, but no readable DDR4 SPD device was found";
                }
            }
            catch (Exception error)
            {
                errorText = error.GetType().Name + ": " + error.Message;
            }
            return profiles;
        }

        private static void AddTiming(List<MemoryTimingRecord> target, string name, string group, decimal nanoseconds, decimal cycleTime, int forcedCycles)
        {
            if (nanoseconds <= 0 || cycleTime <= 0)
            {
                return;
            }
            target.Add(new MemoryTimingRecord
            {
                name = name,
                group = group,
                cycles = forcedCycles > 0 ? forcedCycles : (int)Math.Ceiling(nanoseconds / cycleTime),
                nanoseconds = decimal.Round(nanoseconds, 3),
                source = "SPD minimum"
            });
        }

        private static int SelectCasLatency(DDR4Timings timings, decimal cycleTime)
        {
            int minimum = (int)Math.Ceiling(timings.MinimumCASLatencyTime / cycleTime);
            foreach (int value in timings.CASLatenciesSupported)
            {
                if (value >= minimum)
                {
                    return value;
                }
            }
            return minimum;
        }

        private static uint DataRateFromCycleTime(decimal cycleTime)
        {
            if (cycleTime <= 0)
            {
                return 0;
            }
            return (uint)Math.Round(2000m / cycleTime, MidpointRounding.AwayFromZero);
        }

        private static string Text(object value)
        {
            return value == null ? string.Empty : Convert.ToString(value, CultureInfo.InvariantCulture).Trim();
        }

        private static ulong Number(object value)
        {
            try
            {
                return value == null ? 0UL : Convert.ToUInt64(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return 0UL;
            }
        }

        private static uint UIntNumber(object value)
        {
            ulong number = Number(value);
            return number > uint.MaxValue ? uint.MaxValue : (uint)number;
        }

        private static string FormFactorName(uint value)
        {
            return value == 12 ? "SODIMM" : value == 8 ? "DIMM" : value == 0 ? "Unknown" : "Type " + value.ToString(CultureInfo.InvariantCulture);
        }

        private static string MemoryTypeName(uint value)
        {
            return value == 26 ? "DDR4" : value == 34 ? "DDR5" : value == 0 ? "Unknown" : "SMBIOS " + value.ToString(CultureInfo.InvariantCulture);
        }

        private static string JoinName(string manufacturer, string partNumber)
        {
            if (string.IsNullOrWhiteSpace(manufacturer))
            {
                return string.IsNullOrWhiteSpace(partNumber) ? "Memory module" : partNumber;
            }
            return string.IsNullOrWhiteSpace(partNumber) ? manufacturer : manufacturer + " " + partNumber;
        }
    }
}
