// Nutrient deficiencies: what the vision model may flag, in plain language, with honest advice.
//
// A photograph can only ever SUGGEST a deficiency. Yellowing can be a shortage of nitrogen, but it
// can just as easily be waterlogging, root damage, a virus or herbicide drift. So this file is
// written to never pretend otherwise:
//   - the app says "possible nutrient deficiency", never "your soil is short of X"
//   - every entry ends with the same instruction: confirm with a soil test or the district agronomist
//     before buying fertilizer
//   - the cheap, low-risk actions come first (manure, compost, rotation, drainage, lime only after a
//     soil test), and mineral fertilizer is phrased as "the rate your advisor recommends"
//
// Adding a nutrient is a data change: add one entry here, nothing else needs editing.

export const NUTRIENTS = [
  {
    code: "nitrogen",
    en: "Nitrogen (N)",
    rw: "Azote (N)",
    signs: "older leaves pale yellow, yellowing starting at the leaf tip and running down the midrib in a V, thin stunted plants",
    cause: { en: "Low nitrogen, or roots that cannot take it up (waterlogging, compaction, root damage)", rw: "Azote nkeya, cyangwa imizi idashobora kuyifata (ubutaka buvanze n'amazi, ubutaka bwumye cyane)" },
    fix: {
      en: "Spread well-rotted manure or compost (2–3 handfuls per plant), and rotate with beans or other legumes next season. If a soil test confirms low nitrogen, ask your advisor for the right urea or CAN rate and split it into two doses — never one big dose.",
      rw: "Sasa ifumbire y'ubwoya cyangwa compost yaboroye (ingarika 2–3 kuri buri mbuto), kandi uhindure ibihingwa n'ibishyimbo cyangwa ibindi bihingwa bifata azote mu gihe gitaha. Niba isuzuma ry'ubutaka ryerekanye azote nkeya, baza umujyanama ku kigero cya urea cyangwa CAN, kandi ugabanye kabiri — ntukabikore rimwe.",
    },
  },
  {
    code: "phosphorus",
    en: "Phosphorus (P)",
    rw: "Fosifore (P)",
    signs: "dark green or purple leaves and stems, purple tinge on the underside of older leaves, weak roots and late flowering",
    cause: { en: "Low phosphorus, often worse in acid soil or when the soil is cold and wet", rw: "Fosifore nkeya, cyane cyane mu butaka bwa aside cyangwa iyo ubutaka bukonje kandi bufite amazi" },
    fix: {
      en: "Apply manure or compost and keep the soil pH right — phosphorus is locked up in very acid soil. Only buy TSP or DAP at planting if a soil test shows it is short; ask your advisor for the rate.",
      rw: "Sasa ifumbire y'ubwoya cyangwa compost kandi urebe ko ubutaka butari aside cyane — fosifore ifatwa n'ubutaka bwa aside. Gugura TSP cyangwa DAP mu gihe cyo guhinga gusa niba isuzuma ry'ubutaka ryabigaragaje; baza umujyanama ku kigero.",
    },
  },
  {
    code: "potassium",
    en: "Potassium (K)",
    rw: "Potasiyumu (K)",
    signs: "brown, scorched leaf margins and tips on older leaves, weak stems, small or poorly filled cobs, pods and tubers",
    cause: { en: "Low potassium, or a dry spell that stops the plant taking it up", rw: "Potasiyumu nkeya, cyangwa igihe cy'ubukonje bw'amazi kibujije igihingwa kuyifata" },
    fix: {
      en: "Return crop residues to the field, add manure or a little wood ash, and keep the crop watered. Buy MOP only where a soil test shows low potassium.",
      rw: "Subiza ibisigazwa by'ibihingwa mu murima, ongeraho ifumbire y'ubwoya cyangwa ivu ry'inkwi nkeya, kandi urebe ko ibihingwa bibona amazi. Gugura MOP gusa niba isuzuma ry'ubutaka ryerekanye potasiyumu nkeya.",
    },
  },
  {
    code: "magnesium",
    en: "Magnesium (Mg)",
    rw: "Magesiyumu (Mg)",
    signs: "yellowing between the veins of older leaves while the veins stay green, sometimes with a rusty or purplish tint",
    cause: { en: "Low magnesium, often on acid, sandy or heavily cropped soil", rw: "Magesiyumu nkeya, cyane cyane ku butaka bwa aside cyangwa bw'umusenyi" },
    fix: {
      en: "A foliar spray of Epsom salt (about 2%, i.e. 20 g in 1 litre of water) gives quick relief, and manure or dolomitic lime fixes it for the next seasons — lime only if a soil test says the soil is acid.",
      rw: "Kumena Epsom salt ku mababi (hafi 2%, ni ukuvuga g 20 mu litiro 1 y'amazi) bifasha vuba, naho ifumbire y'ubwoya cyangwa dolomite bituma ikemuka mu bihe bikurikira — dolomite gusa niba isuzuma ry'ubutaka ryerekanye aside.",
    },
  },
  {
    code: "calcium",
    en: "Calcium (Ca)",
    rw: "Kalisiyumu (Ca)",
    signs: "curled, distorted or torn young leaves, brown tips on new growth, blossom-end rot on tomato or pepper fruit",
    cause: { en: "Low calcium in the soil, or — more often — uneven watering that stops calcium reaching the fruit", rw: "Kalisiyumu nkeya mu butaka, cyangwa — akenshi — amazi adahinduka ku buryo buhagije ku bihingwa" },
    fix: {
      en: "Water evenly and mulch to keep moisture steady. Lime only if a soil test shows the soil is too acid; adding lime blindly can lock up other nutrients.",
      rw: "Tanga amazi ku buryo buhoraho kandi utware ibimera bituma ubuhehere budahinduka. Koresha lime gusa niba isuzuma ry'ubutaka ryerekanye aside nyinshi; kwongera lime utabaye uzi bishobora gufunga izindi ntungamubiri.",
    },
  },
  {
    code: "sulfur",
    en: "Sulfur (S)",
    rw: "Sulfur (S)",
    signs: "young leaves evenly pale yellow (not just between the veins), whole plant stunted, few pods or grains",
    cause: { en: "Low sulfur, common on sandy soil and where only urea has been used for years", rw: "Sulfur nkeya, cyane cyane ku butaka bw'umusenyi n'ahantu hakoreshejwe urea gusa imyaka myinshi" },
    fix: {
      en: "Add manure or compost, and gypsum where the soil is sodic. Ask your advisor before buying a sulfur fertilizer — the amount depends on the soil test.",
      rw: "Ongeraho ifumbire y'ubwoya cyangwa compost, na gypsum aho ubutaka bufite umunyu mwinshi. Baza umujyanama mbere yo kugura ifumbire ya sulfur — ingano iterwa n'isuzuma ry'ubutaka.",
    },
  },
  {
    code: "iron",
    en: "Iron (Fe)",
    rw: "Fer (Fe)",
    signs: "young leaves yellow between green veins, worst at the top of the plant, on soil that is very acid or waterlogged",
    cause: { en: "Iron unavailable to the plant, usually because the soil is too alkaline, too wet or compacted", rw: "Fer idahari ku gihingwa, akenshi kubera ubutaka bufite pH ndende, buvanze n'amazi cyangwa bwumye cyane" },
    fix: {
      en: "Improve drainage and add organic matter; iron is usually present but locked up. A foliar iron chelate can help this season. Do not add lime.",
      rw: "Kiza imiyoboro y'amazi kandi wongere ibinyabuzima mu butaka; fer iba ihari ariko ifunze. Iron chelate ku mababi ishobora gufasha uyu mwaka. Ntukongere lime.",
    },
  },
  {
    code: "zinc",
    en: "Zinc (Zn)",
    rw: "Zinc (Zn)",
    signs: "very short distances between leaves, small narrow leaves, pale or white bands on young leaves, stunted plants",
    cause: { en: "Low zinc, or high pH and heavy phosphorus use blocking uptake", rw: "Zinc nkeya, cyangwa pH ndende n'ikoreshwa ryinshi rya fosifore bibujije kuyifata" },
    fix: {
      en: "A zinc sulphate foliar spray (about 0.5%, i.e. 5 g in 1 litre) corrects it quickly. Long term, manure and the right pH matter more than buying zinc every season.",
      rw: "Kumena zinc sulphate ku mababi (hafi 0.5%, ni ukuvuga g 5 mu litiro 1) bikemura vuba. Mu gihe kirekire, ifumbire y'ubwoya na pH nyiza ni byo by'ingenzi kurusha kugura zinc buri mwaka.",
    },
  },
];

const BY_CODE = new Map(NUTRIENTS.map((n) => [n.code, n]));

export function nutrientInfo(code) {
  return BY_CODE.get(String(code || "").toLowerCase()) || null;
}

// The model answers with one of these codes, or "none".
// The hardest call in the whole app: yellow streaks and mottling. A virus, a magnesium shortage, a
// nitrogen shortage and iron chlorosis can all look like this in a photograph, and the model tends to
// reach for the disease because the crop list names one. So whenever a virus, streak or mosaic is
// named, the result also carries this caution — nobody should pull out plants on a photo alone.
const LOOK_ALIKE_PATTERN = /virus|streak|mosaic|mottle|chloros/i;

export function lookAlikeNote(pestLabel, lang = "en") {
  if (!LOOK_ALIKE_PATTERN.test(String(pestLabel || ""))) return "";
  return lang === "rw"
    ? "Iyi mirongo y'umuhondo ishobora kandi guterwa n'ikibura rya magesiyumu, azote cyangwa fer (iron), kandi ifoto ntishobora kubitandukanya. Reba amababi ashaje (magesiyumu) n'amababi mashya (fer), kandi urebe ko hari udukoko dutwara indwara, mbere yo kwikura igihingwa. Emeza n'isuzuma ry'ubutaka cyangwa umujyanama w'akarere."
    : "Yellow streaks and mottling can also come from a shortage of magnesium, nitrogen or iron, and a photo cannot tell them apart. Look at the older leaves (magnesium and nitrogen) and the youngest ones (iron), and check for the insects that carry the virus, before you pull out any plant. Confirm with a soil test or your district agronomist.";
}

export const NUTRIENT_CODES = NUTRIENTS.map((n) => n.code);

export function normaliseNutrientCode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v || v === "none" || v === "healthy") return null;
  if (BY_CODE.has(v)) return v;
  // tolerate "nitrogen (n)", "n deficiency", "low potassium" and the like
  const hit = NUTRIENTS.find((n) => v.includes(n.code) || v.includes(n.en.toLowerCase().replace(/\s*\(.*\)$/, "")));
  return hit ? hit.code : null;
}

// What the model is told to look at. Deficiencies look much the same on every crop, so this list is
// not per-crop; the crop name is added by the caller.
export function nutrientPromptList() {
  return NUTRIENTS.map((n) => `- ${n.en}: ${n.signs}`).join("\n");
}

export function nutrientLabel(code, lang) {
  const n = nutrientInfo(code);
  if (!n) return lang === "rw" ? "ibura ry'intungamubiri" : "nutrient deficiency";
  return lang === "rw" ? n.rw : n.en;
}

export function nutrientAdvice(code, lang) {
  const n = nutrientInfo(code);
  if (!n) return null;
  return n.fix[lang === "rw" ? "rw" : "en"];
}

export function nutrientCause(code, lang) {
  const n = nutrientInfo(code);
  if (!n) return null;
  return n.cause[lang === "rw" ? "rw" : "en"];
}

// Shown under every nutrient result, in both languages.
export const NUTRIENT_CAUTION = {
  en: "A photo can only suggest this. Yellowing has other causes too (water, roots, viruses). Confirm with a soil test or your district agronomist before you buy fertilizer.",
  rw: "Ifoto ishobora gutanga igitekerezo gusa. Ubuhumane n'abandi bitera (amazi, imizi, virusi). Emeza n'isuzuma ry'ubutaka cyangwa umujyanama w'akarere mbere yo kugura ifumbire.",
};
