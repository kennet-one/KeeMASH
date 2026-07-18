export interface GlossaryEntry {
  terms: string[];
  explanation: string;
  provenance: "IFR fact" | "observed" | "technical inference";
  warning?: string;
}

export const glossary: GlossaryEntry[] = [
  { terms: ["RAM"], explanation: "Оперативна пам'ять системи. Тут важливі не лише обсяг і частота, а також модулі, topology, training і таймінги.", provenance: "technical inference" },
  { terms: ["Power Down Mode", "Power Down"], explanation: "Режим енергозбереження DRAM. Може впливати на затримку виходу пам'яті з idle; на цьому ноуті є observed evidence з memory power-down тесту.", provenance: "observed" },
  { terms: ["NMode", "Command Rate"], explanation: "Кількість тактів між вибором memory rank і командою. Менше значення може бути швидшим, але важчим для стабільності.", provenance: "technical inference" },
  { terms: ["tCL"], explanation: "CAS Latency: затримка між командою читання та появою даних. Саме число без частоти пам'яті не дає повної картини.", provenance: "IFR fact" },
  { terms: ["Force ColdReset", "Force Cold Reset"], explanation: "Примусово запускає повний cold reset і retraining. Може дати довгий чорний екран; recovery plan обов'язковий.", provenance: "IFR fact", warning: "Високий ризик boot/retraining. Не застосовувати без окремого L6 hard gate." },
  { terms: ["MRC Fast Boot"], explanation: "Дозволяє повторно використати частину результатів Memory Reference Code training замість повного тренування на кожному старті.", provenance: "technical inference" },
  { terms: ["Memory Profile"], explanation: "Набір пов'язаних налаштувань пам'яті, який firmware може застосовувати як один профіль.", provenance: "IFR fact" },
  { terms: ["Dynamic Memory Timings"], explanation: "Firmware-механізм, який може динамічно підбирати або перевизначати таймінги замість буквального використання ручних значень.", provenance: "technical inference" },
  { terms: ["CFG Lock", "BIOS Lock"], explanation: "Firmware lock-біти, які обмежують зміну захищених конфігурацій або запис у BIOS-регіон. Це не performance toggle.", provenance: "IFR fact", warning: "Зміна lock-параметрів належить до L6 і потребує backup та recovery." },
  { terms: ["XTU Interface"], explanation: "Інтерфейс firmware для Intel Extreme Tuning Utility. Його наявність не гарантує, що конкретні tuning controls реально дозволені платформою.", provenance: "technical inference" },
  { terms: ["OverClocking Feature"], explanation: "Глобальний firmware gate для частини overclocking controls. На заблокованій мобільній платформі можливості можуть лишатися обмеженими.", provenance: "IFR fact" },
  { terms: ["Wi-Fi SAR", "PTID", "SAR"], explanation: "Регуляторні параметри радіовипромінювання та platform identity. Вони виключені з performance-сценаріїв.", provenance: "IFR fact", warning: "Regulatory/high-risk: не використовувати для performance tuning." },
  { terms: ["VarStore"], explanation: "UEFI-сховище, де setup question тримає значення. Ім'я, VarStoreId та offset важливіші за видимий prompt.", provenance: "IFR fact" },
  { terms: ["QuestionId"], explanation: "Стабільний ідентифікатор IFR question усередині FormSet. Використовується умовами SuppressIf і GrayOutIf.", provenance: "IFR fact" },
  { terms: ["DIMM", "DIMMs"], explanation: "Фізичний модуль оперативної пам'яті. У цьому ноуті встановлено два різні модулі 16+8 GiB.", provenance: "observed" },
  { terms: ["PCIe", "PCIe bus"], explanation: "Шина між CPU/chipset і пристроями, тут насамперед GPU. Gen і width визначають доступну пропускну здатність лінка.", provenance: "technical inference" },
  { terms: ["RX", "TX", "RX/TX"], explanation: "RX приймає дані, TX передає. Значення в monitor показують поточний напрямок трафіку.", provenance: "technical inference" },
  { terms: ["GPU", "VRAM", "GPU/VRAM"], explanation: "GPU виконує графічні/compute задачі, VRAM є його локальною відеопам'яттю.", provenance: "technical inference" },
  { terms: ["telemetry"], explanation: "Read-only потік вимірювань і станів. Телеметрія спостерігає, але сама не змінює firmware.", provenance: "technical inference" },
  { terms: ["Serial"], explanation: "Послідовний канал між KeeMASH і mesh bridge. Сирі команди лишаються канонічними та не перекладаються.", provenance: "technical inference" },
  { terms: ["SHA256"], explanation: "Криптографічний хеш, яким KeeMASH перевіряє, що локальний інсталятор не змінився перед запуском.", provenance: "technical inference" },
  { terms: ["NSIS"], explanation: "Формат Windows-інсталятора KeeMASH. Updater запускає тільки перевірений versioned NSIS build.", provenance: "technical inference" },
  { terms: ["CO2"], explanation: "Оцінка концентрації вуглекислого газу в ppm із mesh-сенсора.", provenance: "technical inference" },
  { terms: ["PM2.5"], explanation: "Концентрація дрібнодисперсних частинок до 2.5 мкм; це показник якості повітря.", provenance: "technical inference" },
];

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function findGlossaryEntry(term: string): GlossaryEntry | null {
  const target = normalize(term);
  return glossary.find((entry) => entry.terms.some((candidate) => normalize(candidate) === target)) ?? null;
}
