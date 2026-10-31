/**
 * Sites: where frames live on the globe — port of TRUNK-CASTER-SDK/src/sites.rs.
 * Country capitals host 10 frames; states and provinces 1; smaller cities
 * an 8x8 plus a 2x2. `TRUNK-GLOBAL/sites.json` is the editable list; this
 * module holds the default written when the file is missing.
 */

import type { Usize, F64 } from "./types.ts";

/** serde kebab-case. */
export type Tier = "capital" | "province" | "city";
export const TIERS: readonly Tier[] = ["capital", "province", "city"];

export function tierDefaultFrames(t: Tier): Usize {
  return t === "capital" ? 10 : t === "province" ? 1 : 2;
}

/** (user ports, casters) of the k-th frame at a site of this tier; `undefined` = the fleet's full shape. */
export function tierFrameShape(t: Tier, k: Usize): [Usize, Usize] | undefined {
  if (t === "city") return k === 0 ? [8, 8] : [2, 2];
  return undefined;
}

export interface Site {
  /** Display name, used in the SITE field of Ward-Beck lines. */
  name: string;
  /** Short id used in frame ids: `<slug>-<nn>`. */
  slug: string;
  country: string;
  /** Derived from the country when missing. `#[serde(default)]`. */
  continent: string;
  tier: Tier;
  lat: F64;
  lon: F64;
  /** Defaults to the tier's count. `#[serde(default)]` (0 → normalized). */
  frames: Usize;
}
/** What a hand-edited `sites.json` may omit. */
export type SiteInput = Omit<Site, "continent" | "frames"> & { continent?: string; frames?: Usize };

export interface Sites {
  sites: Site[];
}

export function totalFrames(s: Sites): Usize {
  return s.sites.reduce((n, x) => n + x.frames, 0);
}

/** `Sites::normalize`: fill in continents, frame counts and slugs a hand-edited file left out. Mutates and returns. */
export function normalizeSites(s: { sites: SiteInput[] }): Sites {
  for (const x of s.sites) {
    if (!x.continent) x.continent = continentOf(x.country);
    if (!x.frames) x.frames = tierDefaultFrames(x.tier);
    if (x.slug === "") x.slug = slugify(x.name);
  }
  return s as Sites;
}

export type Continent =
  | "North America"
  | "South America"
  | "Europe"
  | "Africa"
  | "Middle East"
  | "Asia"
  | "Oceania"
  | "Other";
export const CONTINENTS: readonly Continent[] = ["North America", "South America", "Europe", "Africa", "Middle East", "Asia", "Oceania", "Other"];

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The continent a country sits on (substring match, first list wins — order matters). */
export function continentOf(country: string): Continent {
  const c = asciiLower(country);
  const is = (names: string[]): boolean => names.some((n) => c.includes(n));
  if (is(["united states", "canada", "mexico", "guatemala", "cuba", "panama", "costa rica", "jamaica"])) return "North America";
  if (is(["brazil", "argentina", "chile", "colombia", "peru", "venezuela", "uruguay", "bolivia", "ecuador", "paraguay"])) return "South America";
  if (
    is([
      "united kingdom", "ireland", "france", "germany", "spain", "portugal", "italy", "netherlands", "belgium", "switzerland",
      "austria", "denmark", "norway", "sweden", "finland", "poland", "czech", "hungary", "greece", "ukraine", "russia",
      "romania", "croatia", "serbia", "iceland", "luxembourg",
    ])
  )
    return "Europe";
  if (is(["egypt", "kenya", "nigeria", "south africa", "morocco", "ghana", "ethiopia", "tanzania", "algeria", "tunisia"])) return "Africa";
  if (
    is([
      "saudi", "emirates", "israel", "türkiye", "turkey", "qatar", "iran", "iraq", "kuwait", "jordan", "lebanon", "oman",
      "bahrain", "syria", "yemen",
    ])
  )
    return "Middle East";
  if (
    is([
      "india", "thailand", "singapore", "malaysia", "indonesia", "philippines", "vietnam",
      "china", "taiwan", "korea", "japan", "pakistan", "bangladesh",
    ])
  )
    return "Asia";
  if (is(["australia", "new zealand", "fiji", "papua"])) return "Oceania";
  return "Other";
}

/** The water a call crosses between two continents. Same continent: `undefined`. */
export function oceanBetween(a: string, b: string): string | undefined {
  if (a === b) return undefined;
  // Rust compares &str bytewise; for these ASCII names UTF-16 `<` agrees.
  const [x, y] = a < b ? [a, b] : [b, a];
  switch (`${x}|${y}`) {
    case "Europe|North America":
      return "North Atlantic";
    case "North America|South America":
      return "Caribbean";
    case "Europe|South America":
    case "Africa|South America":
      return "South Atlantic";
    case "Africa|Europe":
      return "Mediterranean";
    case "Africa|North America":
      return "Atlantic";
    case "Asia|North America":
      return "North Pacific";
    case "Asia|Europe":
      return "Eurasian landline";
    case "Africa|Asia":
      return "Red Sea / Indian Ocean";
    case "Asia|Oceania":
      return "Pacific / Timor Sea";
    case "North America|Oceania":
      return "South Pacific";
    case "Europe|Oceania":
    case "Africa|Oceania":
      return "Indian Ocean";
    case "Oceania|South America":
      return "South Pacific";
    case "Asia|South America":
      return "Pacific";
    case "Europe|Middle East":
      return "Mediterranean / Black Sea";
    case "Africa|Middle East":
      return "Red Sea";
    case "Asia|Middle East":
      return "Arabian Sea";
    case "Middle East|North America":
      return "North Atlantic";
    case "Middle East|Oceania":
      return "Indian Ocean";
    case "Middle East|South America":
      return "South Atlantic";
    default:
      return "open ocean";
  }
}

/**
 * `slugify`: ASCII alphanumerics lowercased, everything else a dash, runs
 * collapsed. Faithful to Rust, so non-ASCII letters become dashes:
 * "Brasília" → "bras-lia", "São Paulo" → "s-o-paulo" (see HANDOFF).
 */
export function slugify(name: string): string {
  let s = "";
  for (const c of name) s += /^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : "-";
  return s
    .split("-")
    .filter((p) => p !== "")
    .join("-");
}

function site(name: string, country: string, tier: Tier, lat: F64, lon: F64): Site {
  return { name, slug: slugify(name), country, continent: continentOf(country), tier, lat, lon, frames: tierDefaultFrames(tier) };
}

/** `Sites::default()`: the built-in list. */
export function defaultSites(): Sites {
  const c = (n: string, co: string, lat: F64, lon: F64): Site => site(n, co, "capital", lat, lon);
  const p = (n: string, co: string, lat: F64, lon: F64): Site => site(n, co, "province", lat, lon);
  const t = (n: string, co: string, lat: F64, lon: F64): Site => site(n, co, "city", lat, lon);
  const sites: Site[] = [
    // Smaller cities: 8x8 + 2x2.
    t("Boston", "United States", 42.36, -71.06),
    t("Chicago", "United States", 41.88, -87.63),
    t("Los Angeles", "United States", 34.05, -118.24),
    t("San Francisco", "United States", 37.77, -122.42),
    t("Seattle", "United States", 47.61, -122.33),
    t("Denver", "United States", 39.74, -104.99),
    t("Atlanta", "United States", 33.75, -84.39),
    t("Miami", "United States", 25.76, -80.19),
    t("Dallas", "United States", 32.78, -96.80),
    t("Nashville", "United States", 36.16, -86.78),
    t("Toronto", "Canada", 43.65, -79.38),
    t("Vancouver", "Canada", 49.28, -123.12),
    t("Montreal", "Canada", 45.50, -73.57),
    t("Manchester", "United Kingdom", 53.48, -2.24),
    t("Glasgow", "United Kingdom", 55.86, -4.25),
    t("Lyon", "France", 45.76, 4.84),
    t("Munich", "Germany", 48.14, 11.58),
    t("Frankfurt", "Germany", 50.11, 8.68),
    t("Milan", "Italy", 45.46, 9.19),
    t("Barcelona", "Spain", 41.39, 2.17),
    t("Rotterdam", "Netherlands", 51.92, 4.48),
    t("Zurich", "Switzerland", 47.38, 8.54),
    t("Gothenburg", "Sweden", 57.71, 11.97),
    t("Kraków", "Poland", 50.06, 19.94),
    t("Cape Town", "South Africa", -33.92, 18.42),
    t("Casablanca", "Morocco", 33.57, -7.59),
    t("Bangalore", "India", 12.97, 77.59),
    t("Osaka City", "Japan", 34.69, 135.50),
    t("Busan", "South Korea", 35.18, 129.08),
    t("Melbourne", "Australia", -37.81, 144.96),
    t("Perth", "Australia", -31.95, 115.86),
    t("Auckland", "New Zealand", -36.85, 174.76),
    t("Guadalajara", "Mexico", 20.66, -103.35),
    t("Medellín", "Colombia", 6.25, -75.56),
    t("Porto Alegre", "Brazil", -30.03, -51.23),
    // More of the Middle East, relay-sized.
    t("Doha", "Qatar", 25.29, 51.53),
    t("Kuwait City", "Kuwait", 29.38, 47.99),
    t("Manama", "Bahrain", 26.23, 50.59),
    t("Muscat", "Oman", 23.59, 58.41),
    t("Amman", "Jordan", 31.95, 35.93),
    t("Beirut", "Lebanon", 33.89, 35.50),
    t("Baghdad", "Iraq", 33.31, 44.37),
    // Country capitals: 10 frames each.
    c("Washington", "United States", 38.90, -77.04),
    c("Ottawa", "Canada", 45.42, -75.70),
    c("Mexico City", "Mexico", 19.43, -99.13),
    c("Brasília", "Brazil", -15.79, -47.88),
    c("Buenos Aires", "Argentina", -34.60, -58.38),
    c("Santiago", "Chile", -33.45, -70.67),
    c("Bogotá", "Colombia", 4.71, -74.07),
    c("Lima", "Peru", -12.05, -77.04),
    c("London", "United Kingdom", 51.51, -0.13),
    c("Dublin", "Ireland", 53.35, -6.26),
    c("Paris", "France", 48.86, 2.35),
    c("Berlin", "Germany", 52.52, 13.41),
    c("Madrid", "Spain", 40.42, -3.70),
    c("Lisbon", "Portugal", 38.72, -9.14),
    c("Rome", "Italy", 41.90, 12.50),
    c("Amsterdam", "Netherlands", 52.37, 4.90),
    c("Brussels", "Belgium", 50.85, 4.35),
    c("Bern", "Switzerland", 46.95, 7.45),
    c("Vienna", "Austria", 48.21, 16.37),
    c("Copenhagen", "Denmark", 55.68, 12.57),
    c("Oslo", "Norway", 59.91, 10.75),
    c("Stockholm", "Sweden", 59.33, 18.07),
    c("Helsinki", "Finland", 60.17, 24.94),
    c("Warsaw", "Poland", 52.23, 21.01),
    c("Prague", "Czechia", 50.08, 14.44),
    c("Budapest", "Hungary", 47.50, 19.04),
    c("Athens", "Greece", 37.98, 23.73),
    c("Ankara", "Türkiye", 39.93, 32.86),
    c("Kyiv", "Ukraine", 50.45, 30.52),
    c("Moscow", "Russia", 55.76, 37.62),
    c("Cairo", "Egypt", 30.04, 31.24),
    c("Nairobi", "Kenya", -1.29, 36.82),
    c("Lagos", "Nigeria", 6.52, 3.38),
    c("Johannesburg", "South Africa", -26.20, 28.05),
    c("Riyadh", "Saudi Arabia", 24.71, 46.68),
    c("Dubai", "United Arab Emirates", 25.20, 55.27),
    c("Tel Aviv", "Israel", 32.09, 34.78),
    c("New Delhi", "India", 28.61, 77.21),
    c("Mumbai", "India", 19.08, 72.88),
    c("Bangkok", "Thailand", 13.76, 100.50),
    c("Singapore", "Singapore", 1.35, 103.82),
    c("Kuala Lumpur", "Malaysia", 3.14, 101.69),
    c("Jakarta", "Indonesia", -6.21, 106.85),
    c("Manila", "Philippines", 14.60, 120.98),
    c("Hanoi", "Vietnam", 21.03, 105.85),
    c("Beijing", "China", 39.90, 116.41),
    c("Shanghai", "China", 31.23, 121.47),
    c("Hong Kong", "China", 22.32, 114.17),
    c("Taipei", "Taiwan", 25.03, 121.57),
    c("Seoul", "South Korea", 37.57, 126.98),
    c("Tokyo", "Japan", 35.68, 139.69),
    c("Canberra", "Australia", -35.28, 149.13),
    c("Sydney", "Australia", -33.87, 151.21),
    c("Wellington", "New Zealand", -41.29, 174.78),
    // US states: 1 frame each (state capitals).
    p("Alabama", "United States", 32.38, -86.30),
    p("Alaska", "United States", 58.30, -134.42),
    p("Arizona", "United States", 33.45, -112.07),
    p("Arkansas", "United States", 34.75, -92.29),
    p("California", "United States", 38.58, -121.49),
    p("Colorado", "United States", 39.74, -104.99),
    p("Connecticut", "United States", 41.76, -72.69),
    p("Delaware", "United States", 39.16, -75.52),
    p("Florida", "United States", 30.44, -84.28),
    p("Georgia", "United States", 33.75, -84.39),
    p("Hawaii", "United States", 21.31, -157.86),
    p("Idaho", "United States", 43.62, -116.20),
    p("Illinois", "United States", 39.80, -89.65),
    p("Indiana", "United States", 39.77, -86.16),
    p("Iowa", "United States", 41.59, -93.62),
    p("Kansas", "United States", 39.05, -95.68),
    p("Kentucky", "United States", 38.20, -84.87),
    p("Louisiana", "United States", 30.46, -91.19),
    p("Maine", "United States", 44.31, -69.78),
    p("Maryland", "United States", 38.98, -76.49),
    p("Massachusetts", "United States", 42.36, -71.06),
    p("Michigan", "United States", 42.73, -84.56),
    p("Minnesota", "United States", 44.95, -93.09),
    p("Mississippi", "United States", 32.30, -90.18),
    p("Missouri", "United States", 38.58, -92.17),
    p("Montana", "United States", 46.59, -112.04),
    p("Nebraska", "United States", 40.81, -96.70),
    p("Nevada", "United States", 39.16, -119.77),
    p("New Hampshire", "United States", 43.21, -71.54),
    p("New Jersey", "United States", 40.22, -74.76),
    p("New Mexico", "United States", 35.69, -105.94),
    p("New York", "United States", 42.65, -73.76),
    p("North Carolina", "United States", 35.78, -78.64),
    p("North Dakota", "United States", 46.81, -100.78),
    p("Ohio", "United States", 39.96, -83.00),
    p("Oklahoma", "United States", 35.47, -97.52),
    p("Oregon", "United States", 44.94, -123.03),
    p("Pennsylvania", "United States", 40.26, -76.88),
    p("Rhode Island", "United States", 41.82, -71.41),
    p("South Carolina", "United States", 34.00, -81.03),
    p("South Dakota", "United States", 44.37, -100.35),
    p("Tennessee", "United States", 36.17, -86.78),
    p("Texas", "United States", 30.27, -97.74),
    p("Utah", "United States", 40.76, -111.89),
    p("Vermont", "United States", 44.26, -72.58),
    p("Virginia", "United States", 37.54, -77.44),
    p("Washington State", "United States", 47.04, -122.90),
    p("West Virginia", "United States", 38.35, -81.63),
    p("Wisconsin", "United States", 43.07, -89.40),
    p("Wyoming", "United States", 41.14, -104.82),
    // Canadian provinces and territories.
    p("British Columbia", "Canada", 48.43, -123.37),
    p("Alberta", "Canada", 53.55, -113.49),
    p("Saskatchewan", "Canada", 50.45, -104.62),
    p("Manitoba", "Canada", 49.90, -97.14),
    p("Ontario", "Canada", 43.65, -79.38),
    p("Quebec", "Canada", 46.81, -71.21),
    p("New Brunswick", "Canada", 45.96, -66.64),
    p("Nova Scotia", "Canada", 44.65, -63.58),
    p("Prince Edward Island", "Canada", 46.24, -63.13),
    p("Newfoundland and Labrador", "Canada", 47.56, -52.71),
    p("Yukon", "Canada", 60.72, -135.06),
    p("Northwest Territories", "Canada", 62.45, -114.37),
    p("Nunavut", "Canada", 63.75, -68.52),
    // Australian states and territories.
    p("New South Wales", "Australia", -33.87, 151.21),
    p("Victoria", "Australia", -37.81, 144.96),
    p("Queensland", "Australia", -27.47, 153.03),
    p("Western Australia", "Australia", -31.95, 115.86),
    p("South Australia", "Australia", -34.93, 138.60),
    p("Tasmania", "Australia", -42.88, 147.33),
    p("Northern Territory", "Australia", -12.46, 130.84),
    // UK nations.
    p("Scotland", "United Kingdom", 55.95, -3.19),
    p("Wales", "United Kingdom", 51.48, -3.18),
    p("Northern Ireland", "United Kingdom", 54.60, -5.93),
    // German Länder (a few).
    p("Bavaria", "Germany", 48.14, 11.58),
    p("North Rhine-Westphalia", "Germany", 51.23, 6.78),
    p("Hamburg", "Germany", 53.55, 9.99),
    // Indian states (a few).
    p("Maharashtra", "India", 19.08, 72.88),
    p("Karnataka", "India", 12.97, 77.59),
    p("Tamil Nadu", "India", 13.08, 80.27),
    // Brazilian states (a few).
    p("São Paulo", "Brazil", -23.55, -46.63),
    p("Rio de Janeiro", "Brazil", -22.91, -43.17),
    // Japanese prefectures (a few).
    p("Osaka", "Japan", 34.69, 135.50),
    p("Hokkaido", "Japan", 43.06, 141.35),
  ];
  return { sites };
}

/** `airport_of`'s table: lowercase name prefix → IATA code. */
const AIRPORTS: readonly (readonly [string, string])[] = [
  ["alabama", "BHM"], ["alaska", "ANC"], ["alberta", "YYC"], ["amman", "AMM"], ["amsterdam", "AMS"], ["ankara", "ESB"],
  ["arizona", "PHX"], ["arkansas", "LIT"], ["athens", "ATH"], ["atlanta", "ATL"], ["auckland", "AKL"], ["baghdad", "BGW"],
  ["bangalore", "BLR"], ["bangkok", "BKK"], ["barcelona", "BCN"], ["bavaria", "MUC"], ["beijing", "PEK"], ["beirut", "BEY"],
  ["berlin", "BER"], ["bern", "BRN"], ["bogot", "BOG"], ["boston", "BOS"], ["bras", "BSB"], ["british columbia", "YVR"],
  ["brussels", "BRU"], ["budapest", "BUD"], ["buenos aires", "EZE"], ["busan", "PUS"], ["cairo", "CAI"], ["california", "LAX"],
  ["canberra", "CBR"], ["cape town", "CPT"], ["casablanca", "CMN"], ["chicago", "ORD"], ["colorado", "DEN"], ["connecticut", "BDL"],
  ["copenhagen", "CPH"], ["dallas", "DFW"], ["delaware", "ILG"], ["denver", "DEN"], ["doha", "DOH"], ["dubai", "DXB"],
  ["dublin", "DUB"], ["florida", "MCO"], ["frankfurt", "FRA"], ["georgia", "ATL"], ["glasgow", "GLA"], ["gothenburg", "GOT"],
  ["guadalajara", "GDL"], ["hamburg", "HAM"], ["hanoi", "HAN"], ["hawaii", "HNL"], ["helsinki", "HEL"], ["hokkaido", "CTS"],
  ["hong kong", "HKG"], ["idaho", "BOI"], ["illinois", "ORD"], ["indiana", "IND"], ["iowa", "DSM"], ["jakarta", "CGK"],
  ["johannesburg", "JNB"], ["kansas", "ICT"], ["karnataka", "BLR"], ["kentucky", "SDF"], ["krak", "KRK"], ["kuala lumpur", "KUL"],
  ["kuwait", "KWI"], ["kyiv", "KBP"], ["lagos", "LOS"], ["lima", "LIM"], ["lisbon", "LIS"], ["london", "LHR"],
  ["los angeles", "LAX"], ["louisiana", "MSY"], ["lyon", "LYS"], ["madrid", "MAD"], ["maharashtra", "BOM"], ["maine", "PWM"],
  ["manama", "BAH"], ["manchester", "MAN"], ["manila", "MNL"], ["manitoba", "YWG"], ["maryland", "BWI"], ["massachusetts", "BOS"],
  ["medell", "MDE"], ["melbourne", "MEL"], ["mexico city", "MEX"], ["miami", "MIA"], ["michigan", "DTW"], ["milan", "MXP"],
  ["minnesota", "MSP"], ["mississippi", "JAN"], ["missouri", "STL"], ["montana", "BZN"], ["montreal", "YUL"], ["moscow", "SVO"],
  ["mumbai", "BOM"], ["munich", "MUC"], ["muscat", "MCT"], ["nairobi", "NBO"], ["nashville", "BNA"], ["nebraska", "OMA"],
  ["nevada", "LAS"], ["new brunswick", "YQM"], ["new delhi", "DEL"], ["new hampshire", "MHT"], ["new jersey", "EWR"],
  ["new mexico", "ABQ"], ["new south wales", "SYD"], ["new york", "JFK"], ["newfoundland", "YYT"], ["north carolina", "CLT"],
  ["north dakota", "FAR"], ["north rhine", "DUS"], ["northern ireland", "BFS"], ["northern territory", "DRW"],
  ["northwest territories", "YZF"], ["nova scotia", "YHZ"], ["nunavut", "YFB"], ["ohio", "CLE"], ["oklahoma", "OKC"],
  ["ontario", "YYZ"], ["oregon", "PDX"], ["osaka", "KIX"], ["oslo", "OSL"], ["ottawa", "YOW"], ["paris", "CDG"],
  ["pennsylvania", "PHL"], ["perth", "PER"], ["porto alegre", "POA"], ["prague", "PRG"], ["prince edward", "YYG"],
  ["quebec", "YQB"], ["queensland", "BNE"], ["rhode island", "PVD"], ["rio de janeiro", "GIG"], ["riyadh", "RUH"],
  ["rome", "FCO"], ["rotterdam", "RTM"], ["san francisco", "SFO"], ["santiago", "SCL"], ["saskatchewan", "YXE"],
  ["scotland", "EDI"], ["seattle", "SEA"], ["seoul", "ICN"], ["shanghai", "PVG"], ["singapore", "SIN"],
  ["south australia", "ADL"], ["south carolina", "CHS"], ["south dakota", "FSD"], ["stockholm", "ARN"], ["sydney", "SYD"],
  ["são paulo", "GRU"], ["sao paulo", "GRU"], ["taipei", "TPE"], ["tamil nadu", "MAA"], ["tasmania", "HBA"],
  ["tel aviv", "TLV"], ["tennessee", "BNA"], ["texas", "DFW"], ["tokyo", "HND"], ["toronto", "YYZ"], ["utah", "SLC"],
  ["vancouver", "YVR"], ["vermont", "BTV"], ["victoria", "MEL"], ["vienna", "VIE"], ["virginia", "IAD"], ["wales", "CWL"],
  ["warsaw", "WAW"], ["washington state", "SEA"], ["washington", "DCA"], ["wellington", "WLG"], ["west virginia", "CRW"],
  ["western australia", "PER"], ["wisconsin", "MKE"], ["wyoming", "JAC"], ["yukon", "YXY"], ["zurich", "ZRH"],
];

/**
 * `airport_of`: the IATA code of the main airport serving a site (a city,
 * or a state's or province's biggest airport). The longest matching prefix
 * key wins ("washington state" beats "washington"); unknown sites get their
 * first three ASCII letters, uppercased.
 */
export function airportOf(name: string): string {
  const n = name.toLowerCase();
  let best: readonly [string, string] | undefined;
  for (const e of AIRPORTS) if (n.startsWith(e[0]) && (best === undefined || e[0].length >= best[0].length)) best = e;
  if (best !== undefined) return best[1];
  let out = "";
  for (const c of n) {
    if (out.length === 3) break;
    if (/^[A-Za-z]$/.test(c)) out += c;
  }
  return out.toUpperCase();
}
