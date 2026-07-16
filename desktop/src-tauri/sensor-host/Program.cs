using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Threading;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.PawnIo;

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
        public string name;
        public ulong capacityBytes;
    }

    internal sealed class SensorSnapshot
    {
        public long timestamp;
        public bool pawnIoInstalled;
        public List<SensorRecord> sensors;
        public List<MemoryModuleRecord> memoryModules;
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

                while (!_stopping && ParentIsAlive(parentPid))
                {
                    computer.Accept(visitor);
                    SensorSnapshot snapshot = new SensorSnapshot
                    {
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        pawnIoInstalled = PawnIo.IsInstalled,
                        sensors = ReadSensors(computer),
                        memoryModules = memoryModules
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
                    "SELECT DeviceLocator, BankLabel, Manufacturer, PartNumber, Capacity FROM Win32_PhysicalMemory"))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    foreach (ManagementObject item in results)
                    {
                        string slot = Text(item["DeviceLocator"]);
                        string bank = Text(item["BankLabel"]);
                        string manufacturer = Text(item["Manufacturer"]);
                        string partNumber = Text(item["PartNumber"]);
                        ulong capacity = Number(item["Capacity"]);

                        modules.Add(new MemoryModuleRecord
                        {
                            slot = string.IsNullOrWhiteSpace(slot) ? bank : slot,
                            name = JoinName(manufacturer, partNumber),
                            capacityBytes = capacity
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
