// Crop catalog: the single source of truth for which crops the app understands.
//
// Everything that used to be maize-only reads from here: the Gemini prompt (which pests and
// diseases to look for), the farmer profile, the scanner, and the NASA POWER climate advisory
// (how much water the crop needs and at what heat it starts to suffer).
//
// Adding a crop is a data change: add one entry, no other file needs editing.
//
// Fields:
//   id          short code stored in the database (scans.crop)
//   en / rw     display names, English and Kinyarwanda
//   waterMm     roughly how much rain the crop needs in a full season (mm)
//   seasonDays  typical length of that season, used to prorate the water need to 30 days
//   heatC       daytime temperature above which the crop starts to suffer
//   pests       what the vision model should look for, with the visible signs to look for
//   slugs       the few names the model is allowed to answer with (kept short and stable)

import { nutrientPromptList } from "./nutrients.js";

export const CROPS = [
  {
    id: "maize",
    en: "Maize",
    rw: "Ibigori",
    waterMm: 550,
    seasonDays: 120,
    heatC: 35,
    pests: [
      { name: "fall armyworm", rw: "nkongwa", signs: "window-pane leaf feeding, ragged holes, frass in the whorl, larvae with an inverted Y on the head" },
      { name: "maize stem borer", rw: "udukoko tw'ibigori", signs: "dead heart, shot holes in the funnel leaves, tunnels in the stem" },
      { name: "maize streak virus", rw: "indwara y'imirongo", signs: "sharp broken yellow streaks that follow the veins, mostly on the youngest leaves, plants stunted, leafhoppers nearby — not the even yellowing between the veins of older leaves" },
    ],
  },
  {
    id: "beans",
    en: "Beans",
    rw: "Ibishyimbo",
    waterMm: 350,
    seasonDays: 90,
    heatC: 30,
    pests: [
      { name: "bean fly", rw: "isazi y'ibishyimbo", signs: "yellowing and wilting seedlings, maggots or scars at the stem base" },
      { name: "bean anthracnose", rw: "indwara y'amabara", signs: "dark sunken lesions on pods and stems, black veins under the leaf" },
      { name: "bean rust", rw: "ingese y'ibishyimbo", signs: "small reddish-brown pustules on the underside of leaves" },
      { name: "bacterial blight", rw: "indwara y'amazi", signs: "water-soaked spots that turn brown with a yellow halo" },
    ],
  },
  {
    id: "cassava",
    en: "Cassava",
    rw: "Imyumbati",
    waterMm: 600,
    seasonDays: 300,
    heatC: 35,
    pests: [
      { name: "cassava mosaic disease", rw: "indwara y'ibishishwa", signs: "mottled yellow-green mosaic, distorted and narrowed leaflets" },
      { name: "cassava brown streak", rw: "indwara y'umubiri", signs: "yellow patches on leaves, brown rotting in the tuber" },
      { name: "cassava green mite", rw: "utunyugunyugu", signs: "yellow speckling and stunted shoot tips" },
      { name: "mealybug", rw: "udukoko tw'ibyoya", signs: "white waxy clusters on stems and leaf joints" },
    ],
  },
  {
    id: "banana",
    en: "Banana",
    rw: "Ibitoke",
    waterMm: 1200,
    seasonDays: 365,
    heatC: 34,
    pests: [
      { name: "banana xanthomonas wilt", rw: "indwara y'ibitoke", signs: "yellowing leaves that collapse, yellow bacterial ooze from the cut stem" },
      { name: "panama disease", rw: "indwara y'umuzi", signs: "older leaves yellow from the edge, split stem base" },
      { name: "banana weevil", rw: "udukoko tw'ibitoke", signs: "tunnels and jelly-like sap at the base of the stem" },
      { name: "sigatoka", rw: "indwara y'amababi", signs: "streaks turning into dark spots with a grey centre on leaves" },
    ],
  },
  {
    id: "rice",
    en: "Rice",
    rw: "Umuceri",
    waterMm: 1200,
    seasonDays: 120,
    heatC: 35,
    pests: [
      { name: "rice blast", rw: "indwara y'umuceri", signs: "spindle-shaped grey spots with a brown border on leaves" },
      { name: "bacterial leaf blight", rw: "indwara y'amababi", signs: "yellow wavy lesions from the leaf tip that dry out" },
      { name: "rice stem borer", rw: "udukoko tw'umuceri", signs: "dead heart in young plants, white panicles later" },
      { name: "rice yellow mottle virus", rw: "indwara y'umuhondo", signs: "yellow mottling and stunted tillers" },
    ],
  },
  {
    id: "potato",
    en: "Irish potato",
    rw: "Ibirayi",
    waterMm: 550,
    seasonDays: 100,
    heatC: 30,
    pests: [
      { name: "late blight", rw: "indwara y'ibihumyo", signs: "water-soaked grey-green patches with white mould on the leaf edge, fast spread in wet weather" },
      { name: "bacterial wilt", rw: "indwara y'uburwayi bw'umuzi", signs: "wilting of the whole plant while leaves stay green, brown stem tissue" },
      { name: "potato tuber moth", rw: "udukoko tw'ibirayi", signs: "mined leaves and tunnels in the tuber" },
      { name: "aphids", rw: "utunyugunyugu", signs: "clusters of small insects on the underside of leaves, curled tips" },
    ],
  },
  {
    id: "sweet-potato",
    en: "Sweet potato",
    rw: "Ibijumba",
    waterMm: 500,
    seasonDays: 120,
    heatC: 35,
    pests: [
      { name: "sweet potato weevil", rw: "udukoko tw'ibijumba", signs: "holes and bitter tunnels in the roots, yellowing vines" },
      { name: "sweet potato virus disease", rw: "indwara y'ibijumba", signs: "mottled, puckered leaves and stunted growth" },
      { name: "alternaria blight", rw: "indwara y'ibihumyo", signs: "dark circular spots with rings on older leaves" },
    ],
  },
  {
    id: "coffee",
    en: "Coffee",
    rw: "Ikawa",
    waterMm: 1200,
    seasonDays: 365,
    heatC: 30,
    pests: [
      { name: "coffee berry disease", rw: "indwara y'ikawa", signs: "dark sunken lesions on green berries that spread to the whole berry" },
      { name: "coffee leaf rust", rw: "ingese y'ikawa", signs: "orange-yellow powdery spots on the underside of leaves, leaf drop" },
      { name: "coffee berry borer", rw: "udukoko tw'ikawa", signs: "a small hole at the tip of the berry, blackened inside" },
      { name: "antestia bug", rw: "insegerane", signs: "blackening of branches and berries, berry drop" },
    ],
  },
  {
    id: "groundnut",
    en: "Groundnut",
    rw: "Amazimubuto",
    waterMm: 450,
    seasonDays: 110,
    heatC: 33,
    pests: [
      { name: "groundnut rosette virus", rw: "indwara y'uduhumbi", signs: "severely stunted plants with mottled, bunched leaves" },
      { name: "early leaf spot", rw: "indwara y'amababi", signs: "brown spots with a yellow halo, starting on older leaves" },
      { name: "aphids", rw: "utunyugunyugu", signs: "clusters of small insects on young shoots, curled leaves" },
    ],
  },
  {
    id: "soybean",
    en: "Soybean",
    rw: "Soya",
    waterMm: 500,
    seasonDays: 110,
    heatC: 32,
    pests: [
      { name: "soybean rust", rw: "ingese ya soya", signs: "small brown pustules on the underside of leaves" },
      { name: "pod borer", rw: "udukoko tw'ibishyimbo", signs: "holes in pods and bored seeds" },
      { name: "bacterial pustule", rw: "indwara y'amazi", signs: "small raised pustules with a yellow halo" },
    ],
  },
  {
    id: "sorghum",
    en: "Sorghum",
    rw: "Amasaka",
    waterMm: 400,
    seasonDays: 110,
    heatC: 36,
    pests: [
      { name: "sorghum stem borer", rw: "udukoko tw'amasaka", signs: "dead heart, holes in the stem, broken panicles" },
      { name: "sorghum anthracnose", rw: "indwara y'amasaka", signs: "oval spots with a red-brown edge on leaves and grain" },
      { name: "striga weed", rw: "igembe", signs: "purple-flowered parasitic weed, stunted yellow crop around it" },
    ],
  },
  {
    id: "tomato",
    en: "Tomato",
    rw: "Inyanya",
    waterMm: 500,
    seasonDays: 100,
    heatC: 32,
    pests: [
      { name: "late blight", rw: "indwara y'ibihumyo", signs: "greasy dark patches on leaves and fruit with white mould in wet weather" },
      { name: "tuta absoluta", rw: "udukoko tw'inyanya", signs: "blotch mines in leaves, holes in fruit, black frass" },
      { name: "bacterial wilt", rw: "indwara y'umuzi", signs: "sudden wilting while leaves stay green" },
    ],
  },
  {
    id: "cabbage",
    en: "Cabbage",
    rw: "Amashu",
    waterMm: 400,
    seasonDays: 90,
    heatC: 28,
    pests: [
      { name: "diamondback moth", rw: "udukoko tw'amashu", signs: "small larvae in the head, window-pane holes, silk" },
      { name: "aphids", rw: "utunyugunyugu", signs: "grey-green clusters inside the head, curled leaves" },
      { name: "black rot", rw: "indwara y'amashu", signs: "V-shaped yellow patches at the leaf edge, black veins" },
    ],
  },
];

export const CROP_IDS = CROPS.map((c) => c.id);
export const DEFAULT_CROP = "maize";

const BY_ID = new Map(CROPS.map((c) => [c.id, c]));

// Accepts any casing or spacing: "Sweet Potato", "sweet_potato" -> "sweet-potato"
export function normaliseCropId(value) {
  const s = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return BY_ID.has(s) ? s : null;
}

// Never throws: unknown or empty input falls back to maize so old rows and old clients keep working.
export function getCrop(value) {
  return BY_ID.get(normaliseCropId(value) || DEFAULT_CROP) || BY_ID.get(DEFAULT_CROP);
}

export function cropLabel(value, lang) {
  const c = getCrop(value);
  return lang === "rw" ? c.rw : c.en;
}

// Shape used by the API and the browser picker
export function cropOptions() {
  return CROPS.map((c) => ({ id: c.id, en: c.en, rw: c.rw }));
}

// What the vision model should look for, for one crop
export function cropPrompt(cropValue) {
  const c = getCrop(cropValue);
  const list = c.pests
    .map((p) => `- ${p.name} (${p.rw}): look for ${p.signs}`)
    .join("\n");
  return (
    `You are an agronomy assistant specialised in pests, diseases and nutrient problems of ${c.en} ` +
    `(${c.rw}) grown by smallholder farmers in Rwanda and East Africa.\n\n` +
    `Look closely at this leaf or plant photo and answer TWO questions separately.\n\n` +
    `1) Is there pest or disease damage? Check especially for:\n${list}\n\n` +
    `2) Do the leaves show a pattern that suggests a nutrient deficiency? Judges look for:\n` +
    `${nutrientPromptList()}\n\n` +
    `Pests and deficiencies can happen together, so answer both. Use the damage pattern to decide: ` +
    `holes, chewing, frass, wilting, spots, mould or streaks point to a pest or disease; ` +
    `even yellowing, browning from the leaf edge, colour between or along the veins, ` +
    `or distortion of young leaves with no insect damage points to a nutrient problem. ` +
    `If the plant looks healthy, say so for both.`
  );
}

// Prompt fragment listing local names, for the assistant chat
export function cropChatNote(cropValue) {
  const c = getCrop(cropValue);
  const names = c.pests.map((p) => `${p.name} (${p.rw})`).join(", ");
  return `The crop the farmer is asking about is ${c.en} (${c.rw}). The main problems on this crop in Rwanda are: ${names}.`;
}

// Water the crop needs in a 30-day slice of its season (mm)
export function waterNeed30(cropValue) {
  const c = getCrop(cropValue);
  return Math.round((c.waterMm * 30) / c.seasonDays);
}

// Wet weather raises the risk of these diseases on each crop; used by the climate advisory so the
// warning names the disease a farmer would actually look for instead of "fungus".
const WET_DISEASE = {
  maize: "leaf blights and ear rots; armyworm also damages stressed maize faster",
  beans: "bean anthracnose and bean rust",
  cassava: "cassava bacterial blight and root rot in waterlogged soil",
  banana: "sigatoka and banana xanthomonas wilt spread faster in wet weather",
  rice: "rice blast and bacterial leaf blight",
  potato: "late blight — inspect the lower leaves every day",
  "sweet-potato": "alternaria blight and vine rot",
  coffee: "coffee berry disease and coffee leaf rust",
  groundnut: "early leaf spot and groundnut rosette",
  soybean: "soybean rust and bacterial pustule",
  sorghum: "sorghum anthracnose and grain mould",
  tomato: "late blight and bacterial wilt",
  cabbage: "black rot and clubroot",
};

export function wetWeatherDisease(cropValue) {
  return WET_DISEASE[getCrop(cropValue).id] || "fungal and bacterial diseases";
}

// Validates a list of crop ids from a form or API call: drops unknown ones, de-duplicates, keeps order.
export function cropList(value, { max = 6, fallback = [DEFAULT_CROP] } = {}) {
  const arr = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out = [];
  for (const v of arr) {
    const id = normaliseCropId(v);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? out.slice(0, max) : fallback.slice(0, max);
}
