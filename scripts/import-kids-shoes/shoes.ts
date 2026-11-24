import type { Style } from "@/lib/catalog/types";

/*
 * The kids' shoes in C:\Users\abs55\Documents\KharchnSave\images\New folder
 * (2026-11-23): one listing per folder, one size, one pair. The size comes
 * from the photo named after it (e.g. "31.jpg"); `size` below is what that
 * file said when this list was made, and the import stops if it differs.
 *
 * Names are generic on purpose: several designs copy cartoon characters, team
 * logos or sportswear marks, and unlicensed products shouldn't be sold under
 * those names. Folder 43 has no size photo and is left out.
 */

/** `label`: a shorter name for printed labels, when the name itself is too wide. */
export type Model = { name: string; colour: string; styles: Style[]; description: string; label?: string };

const MADE = "Brand-new pair, made in China.";

const strap = "Hook-and-loop strap for quick on and off.";
const laces = "Lace-up fastening.";

export const MODELS = {
  neonWave: { name: "Neon Wave Runners", colour: "Black/Blue/Green", styles: ["sneakers", "running"], description: `Black lace-up runners on a chunky wave sole that fades from blue to neon green. ${MADE}` },
  zigzag: { name: "Zigzag Runners", colour: "White/Orange", styles: ["sneakers", "running"], description: `Light runners with bold orange zigzag overlays and a cushioned sole. ${laces} ${MADE}` },
  zigzagOrange: { name: "Zigzag Runners", colour: "Orange/White", styles: ["sneakers", "running"], description: `Bright orange runners with zigzag overlays and a matching orange sole. ${laces} ${MADE}` },
  airZigzag: { name: "Air Zigzag Runners", colour: "White/Orange", styles: ["sneakers", "running"], description: `White mesh runners with orange zigzag overlays and an air-bubble heel. ${MADE}` },
  starBear: { name: "Star Bear Sneakers", colour: "Lilac/Pink", styles: ["sneakers"], description: `Pastel sneakers with a teddy bear and a blue star on the side, on a sole printed with hearts. ${strap} ${MADE}` },
  starBearPastel: { name: "Star Bear Sneakers", colour: "Cream/Pastel", styles: ["sneakers"], description: `Cream sneakers with a teddy bear and a blue star on the side, on a soft pink and mint sole. ${strap} ${MADE}` },
  starBearGrey: { name: "Star Bear Sneakers", colour: "Grey/Pastel", styles: ["sneakers"], description: `Light grey sneakers with a teddy bear and a blue star on the side, on a pink and mint sole. ${strap} ${MADE}` },
  starBearWave: { name: "Star Bear Sneakers", colour: "Lilac/Multi", styles: ["sneakers"], description: `Lilac sneakers with a teddy bear and a blue star, on a wavy pink, mint and lilac sole. ${strap} ${MADE}` },
  starBearAir: { name: "Star Bear Air Sneakers", colour: "Cream/Lilac", styles: ["sneakers"], description: `Cream sneakers with a teddy bear and a blue star on the side and an air-bubble sole. ${strap} ${MADE}` },
  starBearToddler: { name: "Star Bear Toddler Sneakers", colour: "Grey/Lilac", styles: ["sneakers"], description: `Small-size sneakers with a teddy bear and a blue star on the side and a bubble sole. ${strap} ${MADE}` },
  lightning: { name: "Lightning Strap Trainers", colour: "Navy/Neon", styles: ["sneakers"], description: `Navy trainers with a wide strap and a lightning-bolt sole in neon colours. ${strap} ${MADE}` },
  easyStrapNavy: { name: "Easy Strap Trainers", colour: "Navy/Grey", styles: ["sneakers"], description: `Navy and grey trainers with a wide strap and a grey sole. ${strap} ${MADE}` },
  starDial: { name: "Star Dial Sneakers", colour: "Black/White", styles: ["sneakers", "casual"], description: `Black and white sneakers with a big star on the side and a twist dial that tightens the laces. ${MADE}` },
  chunkyStreet: { name: "Chunky Street Sneakers", colour: "Black", styles: ["sneakers", "casual"], description: `Black lace-up sneakers on a thick white sole. ${MADE}` },
  meshWindow: { name: "Mesh Window Sneakers", colour: "Grey/Orange", styles: ["sneakers"], description: `Light grey mesh sneakers with an orange window in the heel of the sole. ${MADE}` },
  laceSandals: { name: "Lace Sandals", colour: "Cream/Brown", styles: ["sandals"], description: `Open cream sandals with brown laces and a chunky treaded sole. ${MADE}` },
  twoToneStrap: { name: "Two-Tone Strap Sneakers", colour: "White/Taupe", styles: ["sneakers", "casual"], description: `White sneakers with taupe panels and a hook-and-loop strap. ${MADE}` },
  rainbowSole: { name: "Rainbow Sole Sneakers", colour: "Cream/Yellow", styles: ["sneakers"], description: `Cream sneakers with yellow and navy panels on a translucent rainbow sole. ${strap} ${MADE}` },
  princessRainbow: { name: "Princess Rainbow Sneakers", colour: "Lilac/Pink", styles: ["sneakers"], description: `Lilac mesh sneakers with a princess picture on the side and a rainbow sole. ${strap} ${MADE}` },
  unicornPrincess: { name: "Unicorn Princess Sneakers", colour: "White/Multi", styles: ["sneakers"], description: `White sneakers with a princess and a unicorn on the side and a pastel sole. ${strap} ${MADE}` },
  princessLilac: { name: "Princess Sneakers", colour: "Lilac/White", styles: ["sneakers"], description: `Lilac and white sneakers with a princess picture and a soft lilac sole. ${strap} ${MADE}` },
  princessHighTop: { name: "Princess High-Tops", colour: "White", styles: ["sneakers"], description: `White high-top sneakers with a princess badge, pastel spots and a heart-printed sole. ${strap} ${MADE}` },
  unicornHighTop: { name: "Unicorn High-Tops", colour: "White", styles: ["sneakers"], description: `White high-top sneakers with a unicorn and a princess badge on a pastel sole. ${strap} ${MADE}` },
  strawberryHighTop: { name: "Strawberry High-Tops", colour: "White/Pink", styles: ["sneakers"], description: `White high-tops printed with strawberries and flowers on a pink heart sole. ${strap} ${MADE}` },
  retroStrap: { name: "Retro Strap Sneakers", colour: "Brown/Cream", styles: ["sneakers", "casual"], description: `Brown and cream retro-style sneakers with laces and a strap, on a gum-trim sole. ${MADE}` },
  knitBlush: { name: "Knit Sneakers", colour: "Blush Pink", styles: ["sneakers"], description: `Soft blush-pink knit sneakers with laces and a speckled sole. ${MADE}` },
  chunkyKnit: { name: "Chunky Knit Sneakers", colour: "Pink", styles: ["sneakers"], description: `Pink knit sneakers on a chunky sole with a lilac edge. ${laces} ${MADE}` },
  chevronStar: { name: "Chevron Star Sneakers", colour: "Pink", styles: ["sneakers"], description: `Pink sneakers with shiny metallic chevrons and a star-patterned sole. ${strap} ${MADE}` },
  starSoleLilac: { name: "Star Sole Sneakers", colour: "Lilac", styles: ["sneakers"], description: `Lilac lace-up sneakers on a star-patterned sole. ${MADE}` },
  chevron: { name: "Chevron Sneakers", colour: "Pink/Blue", styles: ["sneakers"], description: `Pink sneakers with shiny blue and metallic chevrons on a bubble sole. ${strap} ${MADE}` },
  chevronHeart: { name: "Chevron Heart Sneakers", colour: "Pink", styles: ["sneakers"], description: `Pink sneakers with metallic chevrons and a sole shaped with pastel hearts. ${strap} ${MADE}` },
  heartSole: { name: "Heart Sole Sneakers", colour: "Pink/Lilac", styles: ["sneakers"], description: `Pink, lilac and yellow sneakers on a bright pink sole with heart cut-outs. ${strap} ${MADE}` },
  airStrap: { name: "Air Strap Sneakers", colour: "White/Grey", styles: ["sneakers", "casual"], description: `White and grey sneakers with two straps and a pink air-bubble heel. ${MADE}` },
  doubleStrap: { name: "Double Strap Sneakers", colour: "Grey/White", styles: ["sneakers", "casual"], description: `Grey and white sneakers with two hook-and-loop straps. ${MADE}` },
  bubbleSole: { name: "Bubble Sole Sneakers", colour: "Pale Pink", styles: ["sneakers"], description: `Pale pink mesh sneakers on a white bubble sole. ${strap} ${MADE}` },
  colourPop: { name: "Colour Pop Sneakers", colour: "Denim Blue", styles: ["sneakers"], description: `Denim-blue sneakers on a white sole with a red toe and a blue heel. ${strap} ${MADE}` },
  colourPopWhite: { name: "Colour Pop Sneakers", colour: "White", styles: ["sneakers"], description: `White mesh sneakers on a white sole with a red toe and a blue heel. ${strap} ${MADE}` },
  colourPopMint: { name: "Colour Pop Sneakers", colour: "White/Mint", styles: ["sneakers"], description: `White sneakers with mint and coral panels on a red and blue sole. ${strap} ${MADE}` },
  waveLilac: { name: "Wave Sneakers", colour: "Lilac/Pink", styles: ["sneakers"], description: `Pink and lilac sneakers with a wave pattern on a soft lilac sole. ${MADE}` },
  swirlStrap: { name: "Swirl Strap Sneakers", colour: "White/Red", styles: ["sneakers"], description: `White sneakers with a red swirl, two straps and a bubble sole. ${MADE}` },
  kittyBow: { name: "Kitty Bow Sneakers", colour: "Pink", styles: ["sneakers"], description: `Pink mesh sneakers with a kitten and a flower on the side and a pink translucent sole. ${MADE}` },
  kittyAir: { name: "Kitty Air Sneakers", colour: "Lilac", styles: ["sneakers"], description: `Lilac mesh sneakers with a kitten and flowers on the side and an air-bubble heel. ${strap} ${MADE}` },
  knitSlipOn: { name: "Knit Slip-Ons", colour: "Neon Yellow/Black", styles: ["sneakers", "casual"], description: `Neon yellow knit slip-ons with black laces and a black and white sole. ${MADE}` },
  patchStrap: { name: "Patch Strap Sneakers", colour: "Taupe", styles: ["sneakers", "casual"], description: `Taupe sneakers with a letter patch and a hook-and-loop strap. ${MADE}` },
  dialCream: { name: "Dial Sneakers", colour: "Cream/Blue", styles: ["sneakers"], description: `Cream sneakers with blue accents and a twist dial that tightens the laces. ${MADE}` },
  heartPatch: { name: "Heart Patch Sneakers", colour: "Pink/Purple", styles: ["sneakers"], description: `Pink and purple sneakers with a heart patch on the side and a soft sole. ${strap} ${MADE}` },
  unicornSwoop: { name: "Unicorn Swoop Sneakers", colour: "Pink", styles: ["sneakers"], description: `Pink and white sneakers with a yellow swoop and a unicorn on the sole. ${strap} ${MADE}` },
  sportStrap: { name: "Sport Strap Sneakers", colour: "Black/Lime", styles: ["sneakers"], description: `Black sneakers with lime-green accents and a wide strap. ${MADE}` },
  courtStrap: { name: "Court Strap Sneakers", colour: "White/Sage", styles: ["sneakers", "casual"], description: `White court-style sneakers with sage, coral and yellow panels. ${strap} ${MADE}` },
  courtBubble: { name: "Court Bubble Sneakers", colour: "White/Sage", styles: ["sneakers", "casual"], description: `White sneakers with sage, coral and yellow panels on a blue and yellow bubble sole. ${strap} ${MADE}` },
  swoopStrap: { name: "Swoop Strap Sneakers", colour: "White/Blue", styles: ["sneakers"], description: `White sneakers with orange and blue swoops on a lilac sole. ${strap} ${MADE}` },
  racer8: { name: "Racer 8 Sneakers", colour: "Black/Orange", styles: ["sneakers", "running"], description: `Black sneakers with a number 8 badge, orange laces and an orange sole trim. ${MADE}` },
  robot: { name: "Robot Sneakers", colour: "Black/Blue", styles: ["sneakers"], description: `Black and blue sneakers with a robot-style design on a white sole with red and blue accents. ${MADE}` },
  cutOutAir: { name: "Cut-Out Air Sneakers", colour: "Beige", styles: ["sneakers"], description: `Beige sneakers with cut-out side panels and an air-bubble heel. ${laces} ${MADE}` },
  starLace: { name: "Star Lace Sneakers", colour: "Lilac", styles: ["sneakers"], description: `Lilac lace-up sneakers with a star badge and a pastel sole. ${MADE}` },
  pastelCourt: { name: "Pastel Court Sneakers", colour: "Pink/Yellow", styles: ["sneakers", "casual"], description: `Lace-up court sneakers in pink, yellow and blue with a green heel. ${MADE}` },
  rainbowDial: { name: "Rainbow Dial Sneakers", colour: "Black/Multi", styles: ["sneakers"], description: `Black sneakers with a rainbow side panel and a twist dial that tightens the laces. ${MADE}` },
  stripeStar: { name: "Stripe Star Sneakers", colour: "White/Blue", styles: ["sneakers"], description: `White sneakers with a blue and red stripe on a star-patterned sole. ${strap} ${MADE}` },
  retroRunner: { name: "Retro Runner Sneakers", colour: "White/Red/Green", styles: ["sneakers", "running"], description: `White and grey sneakers with red and green accents and a hook-and-loop strap. ${MADE}` },
  colourBlockHighTop: { name: "Colour Block High-Tops", label: "Block High-Tops", colour: "Blue/Orange", styles: ["sneakers"], description: `High-top sneakers in blue, orange, green and black, with a strap and a twist dial. ${MADE}` },
  rainbowWave: { name: "Rainbow Wave Sneakers", colour: "Pink", styles: ["sneakers"], description: `Pink mesh sneakers on a pastel rainbow wave sole. ${strap} ${MADE}` },
  pixelHighTop: { name: "Pixel High-Tops", colour: "Navy/White", styles: ["sneakers"], description: `Navy and white high-tops with a red pixel pattern and an air-bubble heel. ${MADE}` },
  classicStrap: { name: "Classic Strap Sneakers", colour: "White", styles: ["sneakers", "casual"], description: `Plain white sneakers with a hook-and-loop strap. ${MADE}` },
  webHero: { name: "Web Hero Sneakers", colour: "Navy/Orange", styles: ["sneakers"], description: `Navy sneakers with a web pattern, a superhero character and orange laces. ${strap} ${MADE}` },
  monogram: { name: "Monogram Sneakers", colour: "Black/White", styles: ["sneakers"], description: `Black monogram-print sneakers with a white upper and strap. ${MADE}` },
  heartSandals: { name: "Heart Sandals", colour: "Peach", styles: ["sandals"], description: `Peach closed-toe sandals with crossover straps and a sparkly heart. ${strap} ${MADE}` },
  meshSandals: { name: "Mesh Sandal Sneakers", colour: "Pink", styles: ["sandals"], description: `Pink mesh sandal sneakers with open sides and a strap. ${MADE}` },
  chunkyLace: { name: "Chunky Lace Sneakers", colour: "Black/Green", styles: ["sneakers"], description: `Black lace-up sneakers on a chunky white sole with a green edge. ${MADE}` },
  colourWave: { name: "Colour Wave Sneakers", colour: "Blue/Neon", styles: ["sneakers"], description: `Light blue sneakers with orange accents on a blue and neon yellow wave sole. ${strap} ${MADE}` },
  starDialCourt: { name: "Star Dial Court Sneakers", colour: "Grey/Green", styles: ["sneakers", "casual"], description: `Grey and white court sneakers with a green star and a twist dial that tightens the laces. ${MADE}` },
} satisfies Record<string, Model>;

export type ModelKey = keyof typeof MODELS;

/** Folder number → [model, size from its size photo]. */
export const FOLDERS: Record<number, [ModelKey, number]> = {
  1: ["neonWave", 32], 2: ["zigzag", 36], 3: ["starBear", 30], 4: ["lightning", 35], 5: ["starDial", 33],
  6: ["chunkyStreet", 32], 7: ["meshWindow", 26], 8: ["lightning", 35], 9: ["laceSandals", 24], 10: ["twoToneStrap", 29],
  11: ["rainbowSole", 31], 12: ["princessRainbow", 34], 13: ["princessHighTop", 32], 14: ["retroStrap", 32], 15: ["starBearPastel", 30],
  16: ["knitBlush", 32], 17: ["unicornPrincess", 33], 18: ["twoToneStrap", 24], 19: ["chevronStar", 34], 20: ["heartSole", 34],
  21: ["airStrap", 24], 22: ["doubleStrap", 24], 23: ["starSoleLilac", 29], 24: ["bubbleSole", 28], 25: ["colourPop", 35],
  26: ["waveLilac", 35], 27: ["swirlStrap", 25], 28: ["kittyBow", 25], 29: ["knitSlipOn", 30], 30: ["patchStrap", 30],
  31: ["colourPopMint", 28], 32: ["dialCream", 24], 33: ["starBearGrey", 31], 34: ["starBearGrey", 30], 35: ["starBear", 29],
  36: ["chunkyKnit", 27], 37: ["princessHighTop", 32], 38: ["heartPatch", 33], 39: ["retroStrap", 28], 40: ["unicornSwoop", 31],
  41: ["sportStrap", 33], 42: ["courtStrap", 33], 44: ["strawberryHighTop", 27], 45: ["heartPatch", 32],
  46: ["swoopStrap", 30], 47: ["princessHighTop", 32], 48: ["chevronHeart", 31], 49: ["chevron", 28], 50: ["chevron", 34],
  51: ["chevronStar", 31], 52: ["courtStrap", 33], 53: ["courtBubble", 30], 54: ["racer8", 32], 55: ["robot", 34],
  56: ["easyStrapNavy", 35], 57: ["unicornSwoop", 31], 58: ["retroStrap", 30], 59: ["cutOutAir", 33], 60: ["starLace", 33],
  61: ["pastelCourt", 31], 62: ["rainbowDial", 34], 63: ["unicornHighTop", 33], 64: ["heartSole", 33], 65: ["heartPatch", 33],
  66: ["zigzagOrange", 34], 67: ["colourPopWhite", 34], 68: ["airZigzag", 33], 69: ["princessLilac", 31], 70: ["stripeStar", 34],
  71: ["starBearWave", 30], 72: ["retroRunner", 31], 73: ["neonWave", 32], 74: ["colourBlockHighTop", 34], 75: ["rainbowWave", 30],
  76: ["unicornSwoop", 30], 77: ["starBearAir", 30], 78: ["pixelHighTop", 33], 79: ["classicStrap", 33], 80: ["chevron", 33],
  81: ["chevron", 34], 82: ["chevronStar", 30], 83: ["chevronHeart", 31], 84: ["retroStrap", 30], 85: ["webHero", 27],
  86: ["webHero", 28], 87: ["swirlStrap", 24], 88: ["monogram", 25], 89: ["monogram", 24], 90: ["patchStrap", 30],
  91: ["patchStrap", 27], 92: ["heartSandals", 27], 93: ["meshSandals", 29.5], 94: ["chunkyLace", 28], 95: ["colourWave", 24],
  96: ["unicornSwoop", 27], 97: ["starBearToddler", 22], 98: ["starBearToddler", 22], 99: ["kittyAir", 22], 100: ["retroStrap", 30],
  101: ["courtBubble", 29], 102: ["chevronHeart", 31], 103: ["starDialCourt", 30], 104: ["retroRunner", 31],
};

/** Folders deliberately not imported, and why. */
export const SKIPPED: Record<number, string> = { 43: "no size photo" };
