/**
 * world.ts -- port plan, the 56 capitals, the state/provincial 8x8 frames, the
 * fixed port numbering, generated keypanels and the world / spawn configs
 * (rts_intercom_sim.py lines 456-695 and 2199-2280).
 */
import { PyRandom, PyValueError, pyInt } from "../py.ts";

export interface PortTypeInfo {
  prefix: string;
  user: boolean;
  talk: boolean;
  listen: boolean;
  desc: string;
}

export const PORT_TYPES: Readonly<Record<string, PortTypeInfo>> = {
  //        prefix          human user?  can talk     can listen    description
  PANEL: { prefix: "PNL", user: true, talk: true, listen: true, desc: "keypanel position" },
  CAM: { prefix: "CAM", user: false, talk: true, listen: true, desc: "camera headset / CCU" },
  LIGHT: { prefix: "LGT", user: false, talk: true, listen: true, desc: "lighting position" },
  AUDIO: { prefix: "AUD", user: false, talk: true, listen: true, desc: "audio position" },
  FIELD: { prefix: "FLD", user: true, talk: true, listen: true, desc: "field / remote 4-wire" },
  IFB: { prefix: "IFB", user: false, talk: false, listen: false, desc: "IFB feed to talent" },
  WLESS: { prefix: "WLS", user: true, talk: false, listen: true, desc: "wireless licence, monitoring (rx only)" },
  PL: { prefix: "PL", user: false, talk: false, listen: false, desc: "party-line" },
  TRUNK: { prefix: "TRK", user: false, talk: false, listen: false, desc: "trunk to another intercom" },
  SPARE: { prefix: "SPR", user: false, talk: false, listen: false, desc: "unassigned" },
};

export type Plan = [type: string, count: number][];
export const DEFAULT_PLAN: Plan = [["PANEL", 24], ["CAM", 10], ["LIGHT", 8], ["AUDIO", 8], ["FIELD", 8], ["IFB", 24], ["WLESS", 24]];
export const SMALL_PLAN: Plan = [["PANEL", 4], ["CAM", 2], ["FIELD", 1], ["IFB", 1]]; // the 8x8 frame

export type Capital = readonly [alpha: string, city: string, country: string, lat: number, lon: number];

/** One intercom per country capital: 56 of them. */
export const WORLD_CAPITALS: readonly Capital[] = [
  ["WASH", "Washington", "United States", 38.9072, -77.0369], ["OTTA", "Ottawa", "Canada", 45.4215, -75.6972],
  ["MEXC", "Mexico City", "Mexico", 19.4326, -99.1332], ["BRAS", "Brasilia", "Brazil", -15.7939, -47.8828],
  ["BUEN", "Buenos Aires", "Argentina", -34.6037, -58.3816], ["SANT", "Santiago", "Chile", -33.4489, -70.6693],
  ["LIMA", "Lima", "Peru", -12.0464, -77.0428], ["BOGO", "Bogota", "Colombia", 4.711, -74.0721],
  ["LOND", "London", "United Kingdom", 51.5074, -0.1278], ["PARI", "Paris", "France", 48.8566, 2.3522],
  ["BERL", "Berlin", "Germany", 52.52, 13.405], ["MADR", "Madrid", "Spain", 40.4168, -3.7038],
  ["LISB", "Lisbon", "Portugal", 38.7223, -9.1393], ["ROME", "Rome", "Italy", 41.9028, 12.4964],
  ["AMST", "Amsterdam", "Netherlands", 52.3676, 4.9041], ["BRUS", "Brussels", "Belgium", 50.8503, 4.3517],
  ["BERN", "Bern", "Switzerland", 46.948, 7.4474], ["VIEN", "Vienna", "Austria", 48.2082, 16.3738],
  ["PRAG", "Prague", "Czechia", 50.0755, 14.4378], ["WARS", "Warsaw", "Poland", 52.2297, 21.0122],
  ["BUDA", "Budapest", "Hungary", 47.4979, 19.0402], ["STOC", "Stockholm", "Sweden", 59.3293, 18.0686],
  ["OSLO", "Oslo", "Norway", 59.9139, 10.7522], ["COPE", "Copenhagen", "Denmark", 55.6761, 12.5683],
  ["HELS", "Helsinki", "Finland", 60.1699, 24.9384], ["DUBL", "Dublin", "Ireland", 53.3498, -6.2603],
  ["ATHE", "Athens", "Greece", 37.9838, 23.7275], ["ANKA", "Ankara", "Turkey", 39.9334, 32.8597],
  ["MOSC", "Moscow", "Russia", 55.7558, 37.6173], ["KYIV", "Kyiv", "Ukraine", 50.4501, 30.5234],
  ["CAIR", "Cairo", "Egypt", 30.0444, 31.2357], ["NAIR", "Nairobi", "Kenya", -1.2921, 36.8219],
  ["ABUJ", "Abuja", "Nigeria", 9.0765, 7.3986], ["PRET", "Pretoria", "South Africa", -25.7479, 28.2293],
  ["ADDI", "Addis Ababa", "Ethiopia", 9.03, 38.74], ["ACCR", "Accra", "Ghana", 5.6037, -0.187],
  ["RABA", "Rabat", "Morocco", 34.0209, -6.8416], ["RIYA", "Riyadh", "Saudi Arabia", 24.7136, 46.6753],
  ["ABUD", "Abu Dhabi", "United Arab Emirates", 24.4539, 54.3773], ["DOHA", "Doha", "Qatar", 25.2854, 51.531],
  ["TEHR", "Tehran", "Iran", 35.6892, 51.389], ["BAGH", "Baghdad", "Iraq", 33.3152, 44.3661],
  ["DELH", "New Delhi", "India", 28.6139, 77.209], ["ISLA", "Islamabad", "Pakistan", 33.6844, 73.0479],
  ["DHAK", "Dhaka", "Bangladesh", 23.8103, 90.4125], ["BEIJ", "Beijing", "China", 39.9042, 116.4074],
  ["TOKY", "Tokyo", "Japan", 35.6762, 139.6503], ["SEOU", "Seoul", "South Korea", 37.5665, 126.978],
  ["BANG", "Bangkok", "Thailand", 13.7563, 100.5018], ["HANO", "Hanoi", "Vietnam", 21.0278, 105.8342],
  ["JAKA", "Jakarta", "Indonesia", -6.2088, 106.8456], ["KUAL", "Kuala Lumpur", "Malaysia", 3.139, 101.6869],
  ["SING", "Singapore", "Singapore", 1.3521, 103.8198], ["MANI", "Manila", "Philippines", 14.5995, 120.9842],
  ["CANB", "Canberra", "Australia", -35.2809, 149.13], ["WELL", "Wellington", "New Zealand", -41.2865, 174.7762],
];
if (WORLD_CAPITALS.length !== 56) throw new Error("WORLD_CAPITALS must hold 56 capitals");

export const CONTINENT: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  const groups: Record<string, string> = {
    "North America": "WASH OTTA MEXC", "South America": "BRAS BUEN SANT LIMA BOGO",
    Europe: "LOND PARI BERL MADR LISB ROME AMST BRUS BERN VIEN PRAG WARS BUDA STOC OSLO COPE HELS DUBL ATHE ANKA MOSC KYIV",
    Africa: "CAIR NAIR ABUJ PRET ADDI ACCR RABA", "Middle East": "RIYA ABUD DOHA TEHR BAGH",
    Asia: "DELH ISLA DHAK BEIJ TOKY SEOU BANG HANO JAKA KUAL SING MANI", Oceania: "CANB WELL",
  };
  for (const [g, alphas] of Object.entries(groups)) for (const a of alphas.split(" ")) out[a] = g;
  if (Object.keys(out).length !== 56) throw new Error("CONTINENT must cover 56 capitals");
  return out;
})();

export const ISO2: Readonly<Record<string, string>> = (() => {
  const codes = (
    "us ca mx br ar cl pe co gb fr de es pt it nl be ch at cz pl hu se no dk fi ie gr tr ru ua " +
    "eg ke ng za et gh ma sa ae qa ir iq in pk bd cn jp kr th vn id my sg ph au nz"
  ).split(" ");
  const out: Record<string, string> = {};
  WORLD_CAPITALS.forEach((c, i) => {
    const code = codes[i];
    if (code) out[c[0]] = code;
  });
  return out;
})();

export type Subsite = readonly [parent: string, name: string, place: string, lat: number, lon: number];

/** Smaller 8x8 frames in every state / provincial capital, hanging off their national capital. */
export const SUBSITES: readonly Subsite[] = [
  // United States
  ["WASH", "US-AL", "Montgomery, Alabama", 32.3792, -86.3077], ["WASH", "US-AK", "Juneau, Alaska", 58.3019, -134.4197],
  ["WASH", "US-AZ", "Phoenix, Arizona", 33.4484, -112.074], ["WASH", "US-AR", "Little Rock, Arkansas", 34.7465, -92.2896],
  ["WASH", "US-CA", "Sacramento, California", 38.5816, -121.4944], ["WASH", "US-CO", "Denver, Colorado", 39.7392, -104.9903],
  ["WASH", "US-CT", "Hartford, Connecticut", 41.7658, -72.6734], ["WASH", "US-DE", "Dover, Delaware", 39.1582, -75.5244],
  ["WASH", "US-FL", "Tallahassee, Florida", 30.4383, -84.2807], ["WASH", "US-GA", "Atlanta, Georgia", 33.749, -84.388],
  ["WASH", "US-HI", "Honolulu, Hawaii", 21.3069, -157.8583], ["WASH", "US-ID", "Boise, Idaho", 43.615, -116.2023],
  ["WASH", "US-IL", "Springfield, Illinois", 39.7817, -89.6501], ["WASH", "US-IN", "Indianapolis, Indiana", 39.7684, -86.1581],
  ["WASH", "US-IA", "Des Moines, Iowa", 41.5868, -93.625], ["WASH", "US-KS", "Topeka, Kansas", 39.0473, -95.6752],
  ["WASH", "US-KY", "Frankfort, Kentucky", 38.2009, -84.8733], ["WASH", "US-LA", "Baton Rouge, Louisiana", 30.4515, -91.1871],
  ["WASH", "US-ME", "Augusta, Maine", 44.3106, -69.7795], ["WASH", "US-MD", "Annapolis, Maryland", 38.9784, -76.4922],
  ["WASH", "US-MA", "Boston, Massachusetts", 42.3601, -71.0589], ["WASH", "US-MI", "Lansing, Michigan", 42.7325, -84.5555],
  ["WASH", "US-MN", "Saint Paul, Minnesota", 44.9537, -93.09], ["WASH", "US-MS", "Jackson, Mississippi", 32.2988, -90.1848],
  ["WASH", "US-MO", "Jefferson City, Missouri", 38.5767, -92.1735], ["WASH", "US-MT", "Helena, Montana", 46.5891, -112.0391],
  ["WASH", "US-NE", "Lincoln, Nebraska", 40.8136, -96.7026], ["WASH", "US-NV", "Carson City, Nevada", 39.1638, -119.7674],
  ["WASH", "US-NH", "Concord, New Hampshire", 43.2081, -71.5376], ["WASH", "US-NJ", "Trenton, New Jersey", 40.2206, -74.7597],
  ["WASH", "US-NM", "Santa Fe, New Mexico", 35.687, -105.9378], ["WASH", "US-NY", "Albany, New York", 42.6526, -73.7562],
  ["WASH", "US-NC", "Raleigh, North Carolina", 35.7796, -78.6382], ["WASH", "US-ND", "Bismarck, North Dakota", 46.8083, -100.7837],
  ["WASH", "US-OH", "Columbus, Ohio", 39.9612, -82.9988], ["WASH", "US-OK", "Oklahoma City, Oklahoma", 35.4676, -97.5164],
  ["WASH", "US-OR", "Salem, Oregon", 44.9429, -123.0351], ["WASH", "US-PA", "Harrisburg, Pennsylvania", 40.2732, -76.8867],
  ["WASH", "US-RI", "Providence, Rhode Island", 41.824, -71.4128], ["WASH", "US-SC", "Columbia, South Carolina", 34.0007, -81.0348],
  ["WASH", "US-SD", "Pierre, South Dakota", 44.3683, -100.351], ["WASH", "US-TN", "Nashville, Tennessee", 36.1627, -86.7816],
  ["WASH", "US-TX", "Austin, Texas", 30.2672, -97.7431], ["WASH", "US-UT", "Salt Lake City, Utah", 40.7608, -111.891],
  ["WASH", "US-VT", "Montpelier, Vermont", 44.2601, -72.5754], ["WASH", "US-VA", "Richmond, Virginia", 37.5407, -77.436],
  ["WASH", "US-WA", "Olympia, Washington", 47.0379, -122.9007], ["WASH", "US-WV", "Charleston, West Virginia", 38.3498, -81.6326],
  ["WASH", "US-WI", "Madison, Wisconsin", 43.0731, -89.4012], ["WASH", "US-WY", "Cheyenne, Wyoming", 41.14, -104.8202],
  // Canada
  ["OTTA", "CA-ON", "Toronto, Ontario", 43.6532, -79.3832], ["OTTA", "CA-QC", "Quebec City, Quebec", 46.8139, -71.208],
  ["OTTA", "CA-BC", "Victoria, British Columbia", 48.4284, -123.3656], ["OTTA", "CA-AB", "Edmonton, Alberta", 53.5461, -113.4938],
  ["OTTA", "CA-MB", "Winnipeg, Manitoba", 49.8951, -97.1384], ["OTTA", "CA-SK", "Regina, Saskatchewan", 50.4452, -104.6189],
  ["OTTA", "CA-NS", "Halifax, Nova Scotia", 44.6488, -63.5752], ["OTTA", "CA-NB", "Fredericton, New Brunswick", 45.9636, -66.6431],
  ["OTTA", "CA-NL", "St. John's, Newfoundland and Labrador", 47.5615, -52.7126], ["OTTA", "CA-PE", "Charlottetown, Prince Edward Island", 46.2382, -63.1311],
  ["OTTA", "CA-YT", "Whitehorse, Yukon", 60.7212, -135.0568], ["OTTA", "CA-NT", "Yellowknife, Northwest Territories", 62.454, -114.3718],
  ["OTTA", "CA-NU", "Iqaluit, Nunavut", 63.7467, -68.517],
  // Australia
  ["CANB", "AU-NSW", "Sydney, New South Wales", -33.8688, 151.2093], ["CANB", "AU-VIC", "Melbourne, Victoria", -37.8136, 144.9631],
  ["CANB", "AU-QLD", "Brisbane, Queensland", -27.4698, 153.0251], ["CANB", "AU-WA", "Perth, Western Australia", -31.9505, 115.8605],
  ["CANB", "AU-SA", "Adelaide, South Australia", -34.9285, 138.6007], ["CANB", "AU-TAS", "Hobart, Tasmania", -42.8821, 147.3272],
  ["CANB", "AU-NT", "Darwin, Northern Territory", -12.4634, 130.8456],
  // Germany
  ["BERL", "DE-BY", "Munich, Bavaria", 48.1351, 11.582], ["BERL", "DE-BW", "Stuttgart, Baden-Wurttemberg", 48.7758, 9.1829],
  ["BERL", "DE-NW", "Dusseldorf, North Rhine-Westphalia", 51.2277, 6.7735], ["BERL", "DE-HE", "Wiesbaden, Hesse", 50.0782, 8.2398],
  ["BERL", "DE-NI", "Hanover, Lower Saxony", 52.3759, 9.732], ["BERL", "DE-SN", "Dresden, Saxony", 51.0504, 13.7373],
  ["BERL", "DE-HH", "Hamburg", 53.5511, 9.9937], ["BERL", "DE-HB", "Bremen", 53.0793, 8.8017],
  ["BERL", "DE-SH", "Kiel, Schleswig-Holstein", 54.3233, 10.1228], ["BERL", "DE-RP", "Mainz, Rhineland-Palatinate", 49.9929, 8.2473],
  ["BERL", "DE-SL", "Saarbrucken, Saarland", 49.2402, 6.9969], ["BERL", "DE-TH", "Erfurt, Thuringia", 50.9848, 11.0299],
  ["BERL", "DE-ST", "Magdeburg, Saxony-Anhalt", 52.1205, 11.6276], ["BERL", "DE-BB", "Potsdam, Brandenburg", 52.3906, 13.0645],
  ["BERL", "DE-MV", "Schwerin, Mecklenburg-Vorpommern", 53.6355, 11.4012],
  // Brazil
  ["BRAS", "BR-SP", "Sao Paulo", -23.5505, -46.6333], ["BRAS", "BR-RJ", "Rio de Janeiro", -22.9068, -43.1729],
  ["BRAS", "BR-MG", "Belo Horizonte, Minas Gerais", -19.9167, -43.9345], ["BRAS", "BR-BA", "Salvador, Bahia", -12.9777, -38.5016],
  ["BRAS", "BR-PE", "Recife, Pernambuco", -8.0476, -34.877], ["BRAS", "BR-CE", "Fortaleza, Ceara", -3.7319, -38.5267],
  ["BRAS", "BR-PA", "Belem, Para", -1.4558, -48.5039], ["BRAS", "BR-AM", "Manaus, Amazonas", -3.119, -60.0217],
  ["BRAS", "BR-PR", "Curitiba, Parana", -25.4284, -49.2733], ["BRAS", "BR-RS", "Porto Alegre, Rio Grande do Sul", -30.0346, -51.2177],
  ["BRAS", "BR-SC", "Florianopolis, Santa Catarina", -27.5954, -48.548], ["BRAS", "BR-GO", "Goiania, Goias", -16.6869, -49.2648],
  ["BRAS", "BR-MT", "Cuiaba, Mato Grosso", -15.6014, -56.0979], ["BRAS", "BR-MS", "Campo Grande, Mato Grosso do Sul", -20.4697, -54.6201],
  ["BRAS", "BR-ES", "Vitoria, Espirito Santo", -20.3155, -40.3128], ["BRAS", "BR-RN", "Natal, Rio Grande do Norte", -5.7945, -35.211],
  ["BRAS", "BR-PB", "Joao Pessoa, Paraiba", -7.1195, -34.845], ["BRAS", "BR-AL", "Maceio, Alagoas", -9.6658, -35.7353],
  ["BRAS", "BR-SE", "Aracaju, Sergipe", -10.9472, -37.0731], ["BRAS", "BR-PI", "Teresina, Piaui", -5.0892, -42.8019],
  ["BRAS", "BR-MA", "Sao Luis, Maranhao", -2.5307, -44.3068], ["BRAS", "BR-TO", "Palmas, Tocantins", -10.184, -48.3336],
  ["BRAS", "BR-RO", "Porto Velho, Rondonia", -8.7612, -63.9004], ["BRAS", "BR-AC", "Rio Branco, Acre", -9.9754, -67.8249],
  ["BRAS", "BR-RR", "Boa Vista, Roraima", 2.8235, -60.6758], ["BRAS", "BR-AP", "Macapa, Amapa", 0.0349, -51.0694],
  // India
  ["DELH", "IN-MH", "Mumbai, Maharashtra", 19.076, 72.8777], ["DELH", "IN-KA", "Bengaluru, Karnataka", 12.9716, 77.5946],
  ["DELH", "IN-TN", "Chennai, Tamil Nadu", 13.0827, 80.2707], ["DELH", "IN-WB", "Kolkata, West Bengal", 22.5726, 88.3639],
  ["DELH", "IN-TS", "Hyderabad, Telangana", 17.385, 78.4867], ["DELH", "IN-GJ", "Gandhinagar, Gujarat", 23.2156, 72.6369],
  ["DELH", "IN-RJ", "Jaipur, Rajasthan", 26.9124, 75.7873], ["DELH", "IN-UP", "Lucknow, Uttar Pradesh", 26.8467, 80.9462],
  ["DELH", "IN-MP", "Bhopal, Madhya Pradesh", 23.2599, 77.4126], ["DELH", "IN-BR", "Patna, Bihar", 25.5941, 85.1376],
  ["DELH", "IN-PB", "Chandigarh, Punjab", 30.7333, 76.7794], ["DELH", "IN-KL", "Thiruvananthapuram, Kerala", 8.5241, 76.9366],
  ["DELH", "IN-OD", "Bhubaneswar, Odisha", 20.2961, 85.8245], ["DELH", "IN-AS", "Dispur, Assam", 26.1433, 91.7898],
  ["DELH", "IN-JH", "Ranchi, Jharkhand", 23.3441, 85.3096], ["DELH", "IN-CT", "Raipur, Chhattisgarh", 21.2514, 81.6296],
  ["DELH", "IN-UK", "Dehradun, Uttarakhand", 30.3165, 78.0322], ["DELH", "IN-HP", "Shimla, Himachal Pradesh", 31.1048, 77.1734],
  ["DELH", "IN-GA", "Panaji, Goa", 15.4909, 73.8278], ["DELH", "IN-AP", "Amaravati, Andhra Pradesh", 16.5062, 80.648],
];

// sub-site k (1..n, table order): SNMP udp 36000+k, console tcp 37000+k, series udp 43000 + 16*k
// (43000 rather than 40000: Windows on the lab machine refuses udp/42000)
export const SUBSITE_SNMP_BASE = 36000, SUBSITE_CONSOLE_BASE = 37000, SUBSITE_SERIES_BASE = 43000, SUBSITE_SERIES_SIZE = 16;

export function subsiteAlpha4(name: string): string {
  const i = name.indexOf("-");
  const cc = i < 0 ? name : name.slice(0, i);
  const st = i < 0 ? "" : name.slice(i + 1);
  return ((cc[0] ?? "") + "-" + st).slice(0, 4).padEnd(4, " ");
}

export interface PortNumbers {
  snmp_port: number;
  console_port: number;
  series: number;
}

export function subsitePorts(k: number): PortNumbers {
  return { snmp_port: SUBSITE_SNMP_BASE + k, console_port: SUBSITE_CONSOLE_BASE + k, series: SUBSITE_SERIES_BASE + SUBSITE_SERIES_SIZE * k };
}

// Capital i (1..56, table order): SNMP udp 16100+i, console tcp 17100+i, series udp 20000+256*i .. +255
export const WORLD_PORT_BASE = 16100;
export const SERIES_BASE = 20000;
export const SERIES_SIZE = 256;

export function capitalPorts(alpha: string): PortNumbers {
  const idx = WORLD_CAPITALS.findIndex((c) => c[0] === alpha);
  if (idx < 0) throw new PyValueError(`'${alpha}' is not in list`);
  const i = idx + 1;
  return { snmp_port: WORLD_PORT_BASE + i, console_port: WORLD_PORT_BASE + 1000 + i, series: SERIES_BASE + SERIES_SIZE * i };
}

/** 'PANEL=24,CAM=10,...' -> plan list */
export function parsePlan(text: string): Plan {
  const plan: Plan = [];
  for (const part of text.split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf("=");
    const t = i < 0 ? part : part.slice(0, i);
    const c = i < 0 ? "" : part.slice(i + 1);
    plan.push([t.trim().toUpperCase(), pyInt(c || "1")]);
  }
  return plan;
}

// ----------------------------------------------------------------------------- ports + generated panels
/** A live endpoint (your computer over UDP, addr set) or a button-panel claim (addr null). */
export interface Endpoint {
  addr: { address: string; port: number } | null;
  name: string;
  last: number;
  frames: Buffer[];
  maxFrames: number;
  seq: number;
  since: number;
  buttons?: boolean;
}

export class Port {
  n: number;
  ptype: string;
  alpha: string;
  user: boolean;
  canTalk: boolean;
  canListen: boolean;
  /** key number (1..8) -> target port number (the generated pretend panel) */
  keys = new Map<number, number>();
  /** each port gets its own identifying tone */
  freq: number;
  endpoint: Endpoint | null = null;
  phase = 0.0;

  constructor(n: number, ptype: string, alpha: string) {
    const info = PORT_TYPES[ptype];
    if (!info) throw new PyValueError(`unknown port type '${ptype}'`);
    this.n = n;
    this.ptype = ptype;
    this.alpha = alpha;
    this.user = info.user;
    this.canTalk = info.talk;
    this.canListen = info.listen;
    this.freq = 220.0 * 2 ** (((n * 7) % 36) / 12.0);
  }
}

export function buildPorts(plan: Plan, overrides?: Record<string, string> | null): Map<number, Port> {
  const ports = new Map<number, Port>();
  let n = 1;
  for (const [ptypeIn, count] of plan) {
    const ptype = ptypeIn.toUpperCase();
    const info = PORT_TYPES[ptype];
    if (!info) throw new PyValueError(`unknown port type '${ptype}'; choose from ${Object.keys(PORT_TYPES).join(", ")}`);
    for (let i = 1; i <= Math.trunc(count); i++) {
      let alpha = info.prefix + String(i).padStart(2, "0");
      const o = overrides?.[String(n)];
      if (o !== undefined) alpha = o.slice(0, 8);
      ports.set(n, new Port(n, ptype, alpha));
      n += 1;
    }
  }
  return ports;
}

const WANTS: Readonly<Record<string, readonly string[]>> = {
  PANEL: ["CAM", "CAM", "IFB", "IFB", "PANEL", "PANEL", "LIGHT", "AUDIO"],
  CAM: ["PANEL", "PANEL", "PANEL", "CAM", "AUDIO", "LIGHT", "PANEL", "IFB"],
  LIGHT: ["PANEL", "PANEL", "LIGHT", "LIGHT", "CAM", "PANEL", "AUDIO", "FIELD"],
  AUDIO: ["PANEL", "PANEL", "IFB", "IFB", "AUDIO", "FIELD", "CAM", "PANEL"],
  FIELD: ["PANEL", "PANEL", "AUDIO", "IFB", "PANEL", "CAM", "FIELD", "PANEL"],
};

/** Give every talk-capable port 8 keys that make sense for what it is (random.Random(1234), byte-for-byte). */
export function generatePanels(ports: Map<number, Port>): void {
  const byType = new Map<string, Port[]>();
  for (const p of ports.values()) {
    const l = byType.get(p.ptype) ?? [];
    l.push(p);
    byType.set(p.ptype, l);
  }
  const r = new PyRandom(1234);
  for (const p of ports.values()) {
    if (!p.canTalk) continue;
    const wants = WANTS[p.ptype] ?? new Array<string>(8).fill("PANEL");
    const used = new Set<number>();
    let k = 1;
    for (const want of wants) {
      let pool = (byType.get(want) ?? []).filter((q) => q.n !== p.n && !used.has(q.n));
      if (!pool.length) pool = [...ports.values()].filter((q) => q.n !== p.n && !used.has(q.n));
      if (!pool.length) break;
      const q = pool[(p.n * 31 + k * 7 + r.randint(0, 2)) % pool.length] as Port;
      p.keys.set(k, q.n);
      used.add(q.n);
      k += 1;
    }
  }
}

// ----------------------------------------------------------------------------- configs
export interface DeviceConfig {
  type: string;
  name: string;
  subtype?: string;
  snmp_port?: number;
  console_port?: number;
  community?: string;
  bind?: string;
  lat?: number | null;
  lon?: number | null;
  coverage_m?: number | null;
  coverage?: [number, number][] | null;
  color?: string | null;
  city?: string | null;
  country?: string | null;
  continent?: string | null;
  iso2?: string | null;
  site_kind?: string;
  parent?: string | null;
  vendor?: string;
  location?: string;
  contact?: string;
  // matrix
  plan?: Plan;
  port_names?: Record<string, string>;
  alpha?: string;
  alpha8?: string;
  series?: number;
  audio_port?: number;
  // rvon
  partner_ip?: string;
  partner?: string;
  codec?: string;
  packet_ms?: number;
  channels_up?: number;
  description?: string;
  // tm2000
  trunks_per_pair?: number;
  standby_ip?: string;
  clear_alloc_timeout?: number;
}

export interface EstateConfig {
  bind?: string;
  community?: string;
  trap_targets?: string[];
  chaos?: number;
  map_port?: number;
  vendor?: string;
  scenario?: string;
  devices: DeviceConfig[];
}

export function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((((h / 60.0) % 2) + 2) % 2 - 1));
  const m = l - c / 2;
  const sector = ((Math.floor(h / 60) % 6) + 6) % 6;
  const table: [number, number, number][] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = table[sector] as [number, number, number];
  const hx = (v: number): string => Math.trunc((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + hx(r) + hx(g) + hx(b);
}

const MATRIX_SUBTYPES = ["adam", "adam-bus", "cronus", "zeus3", "zeus3lite"];
const RVON_SUBTYPES = ["rvon1", "rvon8", "rvonc", "rvonio", "rvon16"];

/** 'tm2000=1,adam=1,cronus=1,rvon16=2' -> config dict with auto ports and map positions */
export function spawnConfig(spec: string, baseSnmp = 16100, community = "public", trapTargets: string[] | null = null, chaos = 0.0,
  center: [number, number] = [40.7128, -74.006], mapPort = 8080): EstateConfig {
  const devices: DeviceConfig[] = [];
  const counters = new Map<string, number>();
  let snmpPort = baseSnmp;
  let consolePort = baseSnmp + 1000;
  for (const partRaw of spec.split(",")) {
    if (!partRaw.trim()) continue;
    const part = partRaw.trim();
    const i = part.indexOf("=");
    const kind = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    const count = i < 0 ? "" : part.slice(i + 1);
    for (let c = 0; c < pyInt(count || "1"); c++) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      let d: DeviceConfig;
      if (kind === "tm" || kind === "tm2000") d = { type: "tm2000", name: "TM" + n };
      else if (MATRIX_SUBTYPES.includes(kind) || kind === "matrix") {
        const sub = kind === "matrix" ? "adam" : kind;
        const short = ({ adam: "ADM", "adam-bus": "ABX", cronus: "CRO", zeus3: "ZEU", zeus3lite: "ZLT" } as Record<string, string>)[sub] ?? "ADM";
        d = { type: "matrix", subtype: sub, name: short + n, alpha: short + n, plan: DEFAULT_PLAN, series: 40000 + SERIES_SIZE * (devices.length + 1) };
      } else if (RVON_SUBTYPES.includes(kind) || kind === "rvon") {
        d = { type: "rvon", subtype: kind !== "rvon" ? kind : "rvon16", name: `${kind.toUpperCase()}-${n}` };
      } else throw new PyValueError(`unknown spawn kind '${kind}'`);
      d.snmp_port = snmpPort;
      d.console_port = consolePort;
      snmpPort += 1;
      consolePort += 1;
      devices.push(d);
    }
  }
  // scatter on the map around the centre
  const [lat0, lon0] = center;
  const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;
  devices.forEach((d, i) => {
    const ang = (2 * Math.PI * i) / Math.max(1, devices.length);
    const r = devices.length === 1 ? 0.0 : 0.06 + 0.02 * (i % 3);
    d.lat = round5(lat0 + r * Math.sin(ang));
    d.lon = round5(lon0 + (r * Math.cos(ang)) / Math.cos((lat0 * Math.PI) / 180));
  });
  const rv = devices.filter((d) => d.type === "rvon");
  for (let i = 0; i < rv.length - 1; i += 2) {
    const a = rv[i] as DeviceConfig;
    const b = rv[i + 1] as DeviceConfig;
    a.partner = b.name;
    b.partner = a.name;
  }
  return { bind: "0.0.0.0", community, trap_targets: trapTargets ?? [], chaos, map_port: mapPort, devices };
}

export interface WorldOptions {
  baseSnmp?: number;
  community?: string;
  trapTargets?: string[] | null;
  chaos?: number;
  mapPort?: number;
  plan?: Plan | null;
  subtype?: string;
  trunksPerPair?: number;
  coverageM?: number;
  capitals?: string[] | null;
  vendor?: string;
  subsites?: boolean;
}

/**
 * One Trunk Master plus one matrix per country capital (all 56, or the `capitals` given),
 * plus a small 8x8 frame in every state / provincial capital of those countries.
 */
export function worldConfig(o: WorldOptions = {}): EstateConfig {
  const baseSnmp = o.baseSnmp ?? 16100;
  const plan = o.plan ?? DEFAULT_PLAN;
  const vendor = o.vendor ?? "RTS";
  const coverageM = o.coverageM ?? 400;
  const capitals = o.capitals;
  const wanted = WORLD_CAPITALS.filter((c) => !capitals || !capitals.length || capitals.includes(c[0]));
  const first = wanted[0];
  if (!first) throw new PyValueError(`no capitals matched ${JSON.stringify(capitals ?? null)}`);
  const devices: DeviceConfig[] = [{
    type: "tm2000", name: "TM-" + vendor.toUpperCase().slice(0, 8), snmp_port: baseSnmp, console_port: baseSnmp + 1000,
    lat: first[3] + 0.01, lon: first[4] + 0.01, city: first[1], country: first[2], continent: CONTINENT[first[0]] ?? null,
    coverage_m: 250, color: "#ffffff", trunks_per_pair: o.trunksPerPair ?? 1, iso2: ISO2[first[0]] ?? null,
    site_kind: "trunkmaster",
  }];
  const hues = WORLD_CAPITALS.length;
  for (const cap of wanted) {
    const [alpha, city, country, lat, lon] = cap;
    const h = ((WORLD_CAPITALS.indexOf(cap) * 360.0) / hues + 200) % 360;
    const d: DeviceConfig = {
      type: "matrix", subtype: o.subtype ?? "adam", name: alpha, alpha, alpha8: city.toUpperCase().slice(0, 8),
      city, country, continent: CONTINENT[alpha] ?? null, iso2: ISO2[alpha] ?? null,
      site_kind: "capital", lat, lon,
      coverage_m: coverageM, color: hslHex(h, 0.75, 0.55), plan,
      ...capitalPorts(alpha), // fixed worldwide, independent of base_snmp
    };
    devices.push(d);
    if (o.subsites ?? true) {
      SUBSITES.forEach(([parent, sname, place, slat, slon], idx) => {
        if (parent !== alpha) return;
        devices.push({
          type: "matrix", subtype: "zeus3lite", name: sname, alpha: subsiteAlpha4(sname), alpha8: sname.slice(0, 8),
          city: place, country, continent: CONTINENT[alpha] ?? null, iso2: ISO2[alpha] ?? null,
          site_kind: "state", parent: alpha, lat: slat, lon: slon,
          coverage_m: coverageM / 2.5, color: hslHex(h, 0.55, 0.7), plan: SMALL_PLAN,
          ...subsitePorts(idx + 1),
        });
      });
    }
  }
  return { bind: "0.0.0.0", community: o.community ?? "public", trap_targets: o.trapTargets ?? [], chaos: o.chaos ?? 0.0,
    map_port: o.mapPort ?? 8080, vendor, devices };
}
