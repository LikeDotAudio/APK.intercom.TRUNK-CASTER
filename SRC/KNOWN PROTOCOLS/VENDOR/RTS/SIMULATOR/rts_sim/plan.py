"""Port plan, the world capitals and their sub-sites, and the fixed port allocation.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import random


# =============================================================================
# Port plan  (the "default 10 types" of things that live on a matrix)
# =============================================================================
PORT_TYPES = {
    #            prefix  human user?  can talk  can listen  description
    "PANEL": dict(prefix="PNL", user=True,  talk=True,  listen=True,  desc="keypanel position"),
    "CAM":   dict(prefix="CAM", user=False, talk=True,  listen=True,  desc="camera headset / CCU"),
    "LIGHT": dict(prefix="LGT", user=False, talk=True,  listen=True,  desc="lighting position"),
    "AUDIO": dict(prefix="AUD", user=False, talk=True,  listen=True,  desc="audio position"),
    "FIELD": dict(prefix="FLD", user=True,  talk=True,  listen=True,  desc="field / remote 4-wire"),
    "IFB":   dict(prefix="IFB", user=False, talk=False, listen=False, desc="IFB feed to talent"),
    "WLESS": dict(prefix="WLS", user=True,  talk=False, listen=True,  desc="wireless licence, monitoring (rx only)"),
    "PL":    dict(prefix="PL",  user=False, talk=False, listen=False, desc="party-line"),
    "TRUNK": dict(prefix="TRK", user=False, talk=False, listen=False, desc="trunk to another intercom"),
    "SPARE": dict(prefix="SPR", user=False, talk=False, listen=False, desc="unassigned"),
}
DEFAULT_PLAN = [["PANEL", 24], ["CAM", 10], ["LIGHT", 8], ["AUDIO", 8], ["FIELD", 8], ["IFB", 24], ["WLESS", 24]]

# One intercom per country capital: 56 of them.  (alpha4, city, country, lat, lon)
WORLD_CAPITALS = [
    ("WASH", "Washington", "United States", 38.9072, -77.0369), ("OTTA", "Ottawa", "Canada", 45.4215, -75.6972),
    ("MEXC", "Mexico City", "Mexico", 19.4326, -99.1332), ("BRAS", "Brasilia", "Brazil", -15.7939, -47.8828),
    ("BUEN", "Buenos Aires", "Argentina", -34.6037, -58.3816), ("SANT", "Santiago", "Chile", -33.4489, -70.6693),
    ("LIMA", "Lima", "Peru", -12.0464, -77.0428), ("BOGO", "Bogota", "Colombia", 4.7110, -74.0721),
    ("LOND", "London", "United Kingdom", 51.5074, -0.1278), ("PARI", "Paris", "France", 48.8566, 2.3522),
    ("BERL", "Berlin", "Germany", 52.5200, 13.4050), ("MADR", "Madrid", "Spain", 40.4168, -3.7038),
    ("LISB", "Lisbon", "Portugal", 38.7223, -9.1393), ("ROME", "Rome", "Italy", 41.9028, 12.4964),
    ("AMST", "Amsterdam", "Netherlands", 52.3676, 4.9041), ("BRUS", "Brussels", "Belgium", 50.8503, 4.3517),
    ("BERN", "Bern", "Switzerland", 46.9480, 7.4474), ("VIEN", "Vienna", "Austria", 48.2082, 16.3738),
    ("PRAG", "Prague", "Czechia", 50.0755, 14.4378), ("WARS", "Warsaw", "Poland", 52.2297, 21.0122),
    ("BUDA", "Budapest", "Hungary", 47.4979, 19.0402), ("STOC", "Stockholm", "Sweden", 59.3293, 18.0686),
    ("OSLO", "Oslo", "Norway", 59.9139, 10.7522), ("COPE", "Copenhagen", "Denmark", 55.6761, 12.5683),
    ("HELS", "Helsinki", "Finland", 60.1699, 24.9384), ("DUBL", "Dublin", "Ireland", 53.3498, -6.2603),
    ("ATHE", "Athens", "Greece", 37.9838, 23.7275), ("ANKA", "Ankara", "Turkey", 39.9334, 32.8597),
    ("MOSC", "Moscow", "Russia", 55.7558, 37.6173), ("KYIV", "Kyiv", "Ukraine", 50.4501, 30.5234),
    ("CAIR", "Cairo", "Egypt", 30.0444, 31.2357), ("NAIR", "Nairobi", "Kenya", -1.2921, 36.8219),
    ("ABUJ", "Abuja", "Nigeria", 9.0765, 7.3986), ("PRET", "Pretoria", "South Africa", -25.7479, 28.2293),
    ("ADDI", "Addis Ababa", "Ethiopia", 9.0300, 38.7400), ("ACCR", "Accra", "Ghana", 5.6037, -0.1870),
    ("RABA", "Rabat", "Morocco", 34.0209, -6.8416), ("RIYA", "Riyadh", "Saudi Arabia", 24.7136, 46.6753),
    ("ABUD", "Abu Dhabi", "United Arab Emirates", 24.4539, 54.3773), ("DOHA", "Doha", "Qatar", 25.2854, 51.5310),
    ("TEHR", "Tehran", "Iran", 35.6892, 51.3890), ("BAGH", "Baghdad", "Iraq", 33.3152, 44.3661),
    ("DELH", "New Delhi", "India", 28.6139, 77.2090), ("ISLA", "Islamabad", "Pakistan", 33.6844, 73.0479),
    ("DHAK", "Dhaka", "Bangladesh", 23.8103, 90.4125), ("BEIJ", "Beijing", "China", 39.9042, 116.4074),
    ("TOKY", "Tokyo", "Japan", 35.6762, 139.6503), ("SEOU", "Seoul", "South Korea", 37.5665, 126.9780),
    ("BANG", "Bangkok", "Thailand", 13.7563, 100.5018), ("HANO", "Hanoi", "Vietnam", 21.0278, 105.8342),
    ("JAKA", "Jakarta", "Indonesia", -6.2088, 106.8456), ("KUAL", "Kuala Lumpur", "Malaysia", 3.1390, 101.6869),
    ("SING", "Singapore", "Singapore", 1.3521, 103.8198), ("MANI", "Manila", "Philippines", 14.5995, 120.9842),
    ("CANB", "Canberra", "Australia", -35.2809, 149.1300), ("WELL", "Wellington", "New Zealand", -41.2865, 174.7762),
]
assert len(WORLD_CAPITALS) == 56

CONTINENT = {}
for _grp, _alphas in {
    "North America": "WASH OTTA MEXC", "South America": "BRAS BUEN SANT LIMA BOGO",
    "Europe": "LOND PARI BERL MADR LISB ROME AMST BRUS BERN VIEN PRAG WARS BUDA STOC OSLO COPE HELS DUBL ATHE ANKA MOSC KYIV",
    "Africa": "CAIR NAIR ABUJ PRET ADDI ACCR RABA", "Middle East": "RIYA ABUD DOHA TEHR BAGH",
    "Asia": "DELH ISLA DHAK BEIJ TOKY SEOU BANG HANO JAKA KUAL SING MANI", "Oceania": "CANB WELL",
}.items():
    for _a in _alphas.split():
        CONTINENT[_a] = _grp
assert len(CONTINENT) == 56

ISO2 = dict(zip([c[0] for c in WORLD_CAPITALS], (
    "us ca mx br ar cl pe co gb fr de es pt it nl be ch at cz pl hu se no dk fi ie gr tr ru ua "
    "eg ke ng za et gh ma sa ae qa ir iq in pk bd cn jp kr th vn id my sg ph au nz").split()))

# Smaller 8x8 frames in every state / provincial capital, hanging off their national capital.
# (parent capital alpha, name, state or province, lat, lon)
SUBSITES = [
    # United States
    ("WASH", "US-AL", "Montgomery, Alabama", 32.3792, -86.3077), ("WASH", "US-AK", "Juneau, Alaska", 58.3019, -134.4197),
    ("WASH", "US-AZ", "Phoenix, Arizona", 33.4484, -112.0740), ("WASH", "US-AR", "Little Rock, Arkansas", 34.7465, -92.2896),
    ("WASH", "US-CA", "Sacramento, California", 38.5816, -121.4944), ("WASH", "US-CO", "Denver, Colorado", 39.7392, -104.9903),
    ("WASH", "US-CT", "Hartford, Connecticut", 41.7658, -72.6734), ("WASH", "US-DE", "Dover, Delaware", 39.1582, -75.5244),
    ("WASH", "US-FL", "Tallahassee, Florida", 30.4383, -84.2807), ("WASH", "US-GA", "Atlanta, Georgia", 33.7490, -84.3880),
    ("WASH", "US-HI", "Honolulu, Hawaii", 21.3069, -157.8583), ("WASH", "US-ID", "Boise, Idaho", 43.6150, -116.2023),
    ("WASH", "US-IL", "Springfield, Illinois", 39.7817, -89.6501), ("WASH", "US-IN", "Indianapolis, Indiana", 39.7684, -86.1581),
    ("WASH", "US-IA", "Des Moines, Iowa", 41.5868, -93.6250), ("WASH", "US-KS", "Topeka, Kansas", 39.0473, -95.6752),
    ("WASH", "US-KY", "Frankfort, Kentucky", 38.2009, -84.8733), ("WASH", "US-LA", "Baton Rouge, Louisiana", 30.4515, -91.1871),
    ("WASH", "US-ME", "Augusta, Maine", 44.3106, -69.7795), ("WASH", "US-MD", "Annapolis, Maryland", 38.9784, -76.4922),
    ("WASH", "US-MA", "Boston, Massachusetts", 42.3601, -71.0589), ("WASH", "US-MI", "Lansing, Michigan", 42.7325, -84.5555),
    ("WASH", "US-MN", "Saint Paul, Minnesota", 44.9537, -93.0900), ("WASH", "US-MS", "Jackson, Mississippi", 32.2988, -90.1848),
    ("WASH", "US-MO", "Jefferson City, Missouri", 38.5767, -92.1735), ("WASH", "US-MT", "Helena, Montana", 46.5891, -112.0391),
    ("WASH", "US-NE", "Lincoln, Nebraska", 40.8136, -96.7026), ("WASH", "US-NV", "Carson City, Nevada", 39.1638, -119.7674),
    ("WASH", "US-NH", "Concord, New Hampshire", 43.2081, -71.5376), ("WASH", "US-NJ", "Trenton, New Jersey", 40.2206, -74.7597),
    ("WASH", "US-NM", "Santa Fe, New Mexico", 35.6870, -105.9378), ("WASH", "US-NY", "Albany, New York", 42.6526, -73.7562),
    ("WASH", "US-NC", "Raleigh, North Carolina", 35.7796, -78.6382), ("WASH", "US-ND", "Bismarck, North Dakota", 46.8083, -100.7837),
    ("WASH", "US-OH", "Columbus, Ohio", 39.9612, -82.9988), ("WASH", "US-OK", "Oklahoma City, Oklahoma", 35.4676, -97.5164),
    ("WASH", "US-OR", "Salem, Oregon", 44.9429, -123.0351), ("WASH", "US-PA", "Harrisburg, Pennsylvania", 40.2732, -76.8867),
    ("WASH", "US-RI", "Providence, Rhode Island", 41.8240, -71.4128), ("WASH", "US-SC", "Columbia, South Carolina", 34.0007, -81.0348),
    ("WASH", "US-SD", "Pierre, South Dakota", 44.3683, -100.3510), ("WASH", "US-TN", "Nashville, Tennessee", 36.1627, -86.7816),
    ("WASH", "US-TX", "Austin, Texas", 30.2672, -97.7431), ("WASH", "US-UT", "Salt Lake City, Utah", 40.7608, -111.8910),
    ("WASH", "US-VT", "Montpelier, Vermont", 44.2601, -72.5754), ("WASH", "US-VA", "Richmond, Virginia", 37.5407, -77.4360),
    ("WASH", "US-WA", "Olympia, Washington", 47.0379, -122.9007), ("WASH", "US-WV", "Charleston, West Virginia", 38.3498, -81.6326),
    ("WASH", "US-WI", "Madison, Wisconsin", 43.0731, -89.4012), ("WASH", "US-WY", "Cheyenne, Wyoming", 41.1400, -104.8202),
    # Canada
    ("OTTA", "CA-ON", "Toronto, Ontario", 43.6532, -79.3832), ("OTTA", "CA-QC", "Quebec City, Quebec", 46.8139, -71.2080),
    ("OTTA", "CA-BC", "Victoria, British Columbia", 48.4284, -123.3656), ("OTTA", "CA-AB", "Edmonton, Alberta", 53.5461, -113.4938),
    ("OTTA", "CA-MB", "Winnipeg, Manitoba", 49.8951, -97.1384), ("OTTA", "CA-SK", "Regina, Saskatchewan", 50.4452, -104.6189),
    ("OTTA", "CA-NS", "Halifax, Nova Scotia", 44.6488, -63.5752), ("OTTA", "CA-NB", "Fredericton, New Brunswick", 45.9636, -66.6431),
    ("OTTA", "CA-NL", "St. John's, Newfoundland and Labrador", 47.5615, -52.7126), ("OTTA", "CA-PE", "Charlottetown, Prince Edward Island", 46.2382, -63.1311),
    ("OTTA", "CA-YT", "Whitehorse, Yukon", 60.7212, -135.0568), ("OTTA", "CA-NT", "Yellowknife, Northwest Territories", 62.4540, -114.3718),
    ("OTTA", "CA-NU", "Iqaluit, Nunavut", 63.7467, -68.5170),
    # Australia
    ("CANB", "AU-NSW", "Sydney, New South Wales", -33.8688, 151.2093), ("CANB", "AU-VIC", "Melbourne, Victoria", -37.8136, 144.9631),
    ("CANB", "AU-QLD", "Brisbane, Queensland", -27.4698, 153.0251), ("CANB", "AU-WA", "Perth, Western Australia", -31.9505, 115.8605),
    ("CANB", "AU-SA", "Adelaide, South Australia", -34.9285, 138.6007), ("CANB", "AU-TAS", "Hobart, Tasmania", -42.8821, 147.3272),
    ("CANB", "AU-NT", "Darwin, Northern Territory", -12.4634, 130.8456),
    # Germany
    ("BERL", "DE-BY", "Munich, Bavaria", 48.1351, 11.5820), ("BERL", "DE-BW", "Stuttgart, Baden-Wurttemberg", 48.7758, 9.1829),
    ("BERL", "DE-NW", "Dusseldorf, North Rhine-Westphalia", 51.2277, 6.7735), ("BERL", "DE-HE", "Wiesbaden, Hesse", 50.0782, 8.2398),
    ("BERL", "DE-NI", "Hanover, Lower Saxony", 52.3759, 9.7320), ("BERL", "DE-SN", "Dresden, Saxony", 51.0504, 13.7373),
    ("BERL", "DE-HH", "Hamburg", 53.5511, 9.9937), ("BERL", "DE-HB", "Bremen", 53.0793, 8.8017),
    ("BERL", "DE-SH", "Kiel, Schleswig-Holstein", 54.3233, 10.1228), ("BERL", "DE-RP", "Mainz, Rhineland-Palatinate", 49.9929, 8.2473),
    ("BERL", "DE-SL", "Saarbrucken, Saarland", 49.2402, 6.9969), ("BERL", "DE-TH", "Erfurt, Thuringia", 50.9848, 11.0299),
    ("BERL", "DE-ST", "Magdeburg, Saxony-Anhalt", 52.1205, 11.6276), ("BERL", "DE-BB", "Potsdam, Brandenburg", 52.3906, 13.0645),
    ("BERL", "DE-MV", "Schwerin, Mecklenburg-Vorpommern", 53.6355, 11.4012),
    # Brazil
    ("BRAS", "BR-SP", "Sao Paulo", -23.5505, -46.6333), ("BRAS", "BR-RJ", "Rio de Janeiro", -22.9068, -43.1729),
    ("BRAS", "BR-MG", "Belo Horizonte, Minas Gerais", -19.9167, -43.9345), ("BRAS", "BR-BA", "Salvador, Bahia", -12.9777, -38.5016),
    ("BRAS", "BR-PE", "Recife, Pernambuco", -8.0476, -34.8770), ("BRAS", "BR-CE", "Fortaleza, Ceara", -3.7319, -38.5267),
    ("BRAS", "BR-PA", "Belem, Para", -1.4558, -48.5039), ("BRAS", "BR-AM", "Manaus, Amazonas", -3.1190, -60.0217),
    ("BRAS", "BR-PR", "Curitiba, Parana", -25.4284, -49.2733), ("BRAS", "BR-RS", "Porto Alegre, Rio Grande do Sul", -30.0346, -51.2177),
    ("BRAS", "BR-SC", "Florianopolis, Santa Catarina", -27.5954, -48.5480), ("BRAS", "BR-GO", "Goiania, Goias", -16.6869, -49.2648),
    ("BRAS", "BR-MT", "Cuiaba, Mato Grosso", -15.6014, -56.0979), ("BRAS", "BR-MS", "Campo Grande, Mato Grosso do Sul", -20.4697, -54.6201),
    ("BRAS", "BR-ES", "Vitoria, Espirito Santo", -20.3155, -40.3128), ("BRAS", "BR-RN", "Natal, Rio Grande do Norte", -5.7945, -35.2110),
    ("BRAS", "BR-PB", "Joao Pessoa, Paraiba", -7.1195, -34.8450), ("BRAS", "BR-AL", "Maceio, Alagoas", -9.6658, -35.7353),
    ("BRAS", "BR-SE", "Aracaju, Sergipe", -10.9472, -37.0731), ("BRAS", "BR-PI", "Teresina, Piaui", -5.0892, -42.8019),
    ("BRAS", "BR-MA", "Sao Luis, Maranhao", -2.5307, -44.3068), ("BRAS", "BR-TO", "Palmas, Tocantins", -10.1840, -48.3336),
    ("BRAS", "BR-RO", "Porto Velho, Rondonia", -8.7612, -63.9004), ("BRAS", "BR-AC", "Rio Branco, Acre", -9.9754, -67.8249),
    ("BRAS", "BR-RR", "Boa Vista, Roraima", 2.8235, -60.6758), ("BRAS", "BR-AP", "Macapa, Amapa", 0.0349, -51.0694),
    # India
    ("DELH", "IN-MH", "Mumbai, Maharashtra", 19.0760, 72.8777), ("DELH", "IN-KA", "Bengaluru, Karnataka", 12.9716, 77.5946),
    ("DELH", "IN-TN", "Chennai, Tamil Nadu", 13.0827, 80.2707), ("DELH", "IN-WB", "Kolkata, West Bengal", 22.5726, 88.3639),
    ("DELH", "IN-TS", "Hyderabad, Telangana", 17.3850, 78.4867), ("DELH", "IN-GJ", "Gandhinagar, Gujarat", 23.2156, 72.6369),
    ("DELH", "IN-RJ", "Jaipur, Rajasthan", 26.9124, 75.7873), ("DELH", "IN-UP", "Lucknow, Uttar Pradesh", 26.8467, 80.9462),
    ("DELH", "IN-MP", "Bhopal, Madhya Pradesh", 23.2599, 77.4126), ("DELH", "IN-BR", "Patna, Bihar", 25.5941, 85.1376),
    ("DELH", "IN-PB", "Chandigarh, Punjab", 30.7333, 76.7794), ("DELH", "IN-KL", "Thiruvananthapuram, Kerala", 8.5241, 76.9366),
    ("DELH", "IN-OD", "Bhubaneswar, Odisha", 20.2961, 85.8245), ("DELH", "IN-AS", "Dispur, Assam", 26.1433, 91.7898),
    ("DELH", "IN-JH", "Ranchi, Jharkhand", 23.3441, 85.3096), ("DELH", "IN-CT", "Raipur, Chhattisgarh", 21.2514, 81.6296),
    ("DELH", "IN-UK", "Dehradun, Uttarakhand", 30.3165, 78.0322), ("DELH", "IN-HP", "Shimla, Himachal Pradesh", 31.1048, 77.1734),
    ("DELH", "IN-GA", "Panaji, Goa", 15.4909, 73.8278), ("DELH", "IN-AP", "Amaravati, Andhra Pradesh", 16.5062, 80.6480),
]
SMALL_PLAN = [["PANEL", 4], ["CAM", 2], ["FIELD", 1], ["IFB", 1]]       # the 8x8 frame

# sub-site k (1..n, table order): SNMP udp 36000+k, console tcp 37000+k, series udp 43000 + 16*k (+0 intercom, +1..+8 ports)
# (43000 rather than 40000: Windows on the lab machine refuses udp/42000)
SUBSITE_SNMP_BASE, SUBSITE_CONSOLE_BASE, SUBSITE_SERIES_BASE, SUBSITE_SERIES_SIZE = 36000, 37000, 43000, 16


def subsite_alpha4(name):
    cc, _, st = name.partition("-")
    return (cc[0] + "-" + st)[:4].ljust(4)


def subsite_ports(k):
    return {"snmp_port": SUBSITE_SNMP_BASE + k, "console_port": SUBSITE_CONSOLE_BASE + k,
            "series": SUBSITE_SERIES_BASE + SUBSITE_SERIES_SIZE * k}

# Every capital has one fixed, unique set of ports no matter which emulator process runs it.
# Capital i (1..56, table order):
#   SNMP     udp 16100 + i
#   console  tcp 17100 + i
#   series   udp 20000 + 256*i  ..  + 255 : the intercom's own socket at +0, one socket per
#            matrix port at +n (n = 1..255).  Only the endpoint that owns port n talks on +n.
WORLD_PORT_BASE = 16100
SERIES_BASE = 20000
SERIES_SIZE = 256


def capital_ports(alpha):
    i = [c[0] for c in WORLD_CAPITALS].index(alpha) + 1
    return {"snmp_port": WORLD_PORT_BASE + i, "console_port": WORLD_PORT_BASE + 1000 + i, "series": SERIES_BASE + SERIES_SIZE * i}


def parse_plan(text):
    """'PANEL=24,CAM=10,...' -> plan list"""
    plan = []
    for part in text.split(","):
        if part.strip():
            t, _, c = part.partition("=")
            plan.append([t.strip().upper(), int(c or 1)])
    return plan


class Port:
    __slots__ = ("n", "ptype", "alpha", "user", "can_talk", "can_listen", "keys", "freq", "endpoint", "phase")

    def __init__(self, n, ptype, alpha):
        info = PORT_TYPES[ptype]
        self.n, self.ptype, self.alpha = n, ptype, alpha
        self.user, self.can_talk, self.can_listen = info["user"], info["talk"], info["listen"]
        self.keys = {}          # key number (1..8) -> target port number  (the generated pretend panel)
        self.freq = 220.0 * 2 ** ((n * 7 % 36) / 12.0)   # each port gets its own identifying tone
        self.endpoint = None    # live external endpoint (your computer) if one has claimed this port
        self.phase = 0.0


def build_ports(plan, overrides=None):
    ports, n = {}, 1
    for ptype, count in plan:
        ptype = ptype.upper()
        if ptype not in PORT_TYPES:
            raise ValueError("unknown port type '%s'; choose from %s" % (ptype, ", ".join(PORT_TYPES)))
        for i in range(1, int(count) + 1):
            alpha = "%s%02d" % (PORT_TYPES[ptype]["prefix"], i)
            if overrides and str(n) in overrides:
                alpha = overrides[str(n)][:8]
            ports[n] = Port(n, ptype, alpha)
            n += 1
    return ports


def generate_panels(ports):
    """Give every talk-capable port 8 keys that make sense for what it is."""
    by_type = {}
    for p in ports.values():
        by_type.setdefault(p.ptype, []).append(p)
    rnd = random.Random(1234)
    for p in ports.values():
        if not p.can_talk:
            continue
        wants = {
            "PANEL": ["CAM", "CAM", "IFB", "IFB", "PANEL", "PANEL", "LIGHT", "AUDIO"],
            "CAM":   ["PANEL", "PANEL", "PANEL", "CAM", "AUDIO", "LIGHT", "PANEL", "IFB"],
            "LIGHT": ["PANEL", "PANEL", "LIGHT", "LIGHT", "CAM", "PANEL", "AUDIO", "FIELD"],
            "AUDIO": ["PANEL", "PANEL", "IFB", "IFB", "AUDIO", "FIELD", "CAM", "PANEL"],
            "FIELD": ["PANEL", "PANEL", "AUDIO", "IFB", "PANEL", "CAM", "FIELD", "PANEL"],
        }.get(p.ptype, ["PANEL"] * 8)
        used, k = set(), 1
        for want in wants:
            pool = [q for q in by_type.get(want, []) if q.n != p.n and q.n not in used] or \
                   [q for q in ports.values() if q.n != p.n and q.n not in used]
            if not pool:
                break
            q = pool[(p.n * 31 + k * 7 + rnd.randint(0, 2)) % len(pool)]
            p.keys[k] = q.n
            used.add(q.n)
            k += 1
