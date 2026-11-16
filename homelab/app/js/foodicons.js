// An emoji for a grocery item, from its name (first match wins), else from its aisle.
const WORDS = [
  [/(oat|almond|soy|coconut) ?milk/, '🥛'], [/\bmilk|cream(er)?\b|half.?and.?half/, '🥛'], [/\begg/, '🥚'], [/butter|ghee/, '🧈'], [/cheese|cheddar|parmesan|mozzarella|feta|brie|gouda/, '🧀'], [/yogh?urt|kefir/, '🥣'],
  [/banana/, '🍌'], [/apple/, '🍎'], [/orange|clementine|mandarin|tangerine/, '🍊'], [/lemon|lime/, '🍋'], [/strawberr/, '🍓'], [/blueberr|blackberr|raspberr|berries|berry/, '🫐'], [/grape/, '🍇'], [/watermelon|melon|cantaloupe/, '🍉'],
  [/peach|nectarine|apricot/, '🍑'], [/pear\b/, '🍐'], [/cherr/, '🍒'], [/mango/, '🥭'], [/pineapple/, '🍍'], [/kiwi/, '🥝'], [/avocado|guac/, '🥑'], [/coconut/, '🥥'], [/dragon fruit|pitaya/, '🐉'],
  [/tomato/, '🍅'], [/potato|fries/, '🥔'], [/sweet potato|yam/, '🍠'], [/carrot/, '🥕'], [/corn\b|maize/, '🌽'], [/broccoli|cauliflower/, '🥦'], [/lettuce|salad|spinach|kale|arugula|greens|cabbage|chard/, '🥬'], [/cucumber|pickle/, '🥒'],
  [/pepper|chili|chilli|jalapen/, '🌶️'], [/onion|shallot|scallion|leek/, '🧅'], [/garlic/, '🧄'], [/mushroom/, '🍄'], [/eggplant|aubergine/, '🍆'], [/pumpkin|squash|zucchini/, '🎃'], [/herb|basil|cilantro|parsley|mint|dill|thyme|rosemary/, '🌿'],
  [/bread|loaf|sourdough|baguette|bun\b|buns|roll\b/, '🍞'], [/bagel/, '🥯'], [/croissant/, '🥐'], [/tortilla|wrap|pita|naan/, '🫓'], [/cake|cupcake|muffin/, '🧁'], [/cookie|biscuit/, '🍪'], [/donut|doughnut/, '🍩'], [/pie\b/, '🥧'],
  [/chicken|turkey|poultry|drumstick|wings/, '🍗'], [/beef|steak|mince|ground beef|brisket|roast|ribs/, '🥩'], [/bacon/, '🥓'], [/sausage|hot dog|bratwurst/, '🌭'], [/ham\b|salami|pepperoni|deli/, '🥓'], [/salmon|fish|tuna|cod\b|tilapia|trout|seafood/, '🐟'], [/shrimp|prawn/, '🦐'], [/crab|lobster/, '🦀'],
  [/pasta|spaghetti|noodle|macaroni|penne|ramen/, '🍝'], [/rice\b/, '🍚'], [/cereal|granola|oats|oatmeal|muesli/, '🥣'], [/flour|sugar|baking|yeast|cocoa/, '🧂'], [/salt|spice|seasoning|cinnamon|cumin/, '🧂'], [/oil|vinegar/, '🫒'], [/honey|syrup|jam|jelly|maple/, '🍯'],
  [/peanut|almond|walnut|cashew|nuts?\b|pistachio|trail mix/, '🥜'], [/bean|lentil|chickpea|hummus/, '🫘'], [/soup|broth|stock/, '🍲'], [/sauce|ketchup|mustard|mayo|dressing|salsa|pesto/, '🥫'], [/canned|tin\b|can\b/, '🥫'],
  [/pizza/, '🍕'], [/burger/, '🍔'], [/sandwich|sub\b/, '🥪'], [/taco|burrito/, '🌮'], [/sushi/, '🍣'], [/dumpling/, '🥟'],
  [/ice cream|gelato|popsicle|sorbet/, '🍨'], [/frozen/, '🧊'], [/chip|crisp|pretzel|popcorn|cracker/, '🍿'], [/chocolate|candy|sweet|gum|mint\b/, '🍫'],
  [/coffee|espresso|latte/, '☕'], [/\btea\b|matcha/, '🍵'], [/juice|lemonade/, '🧃'], [/water|sparkling|seltzer/, '💧'], [/soda|cola|pop\b|coke|pepsi|sprite/, '🥤'], [/beer|ale\b|lager/, '🍺'], [/wine|champagne|prosecco/, '🍷'], [/whisk|vodka|gin\b|rum\b|tequila|liquor/, '🥃'],
  [/toilet paper|tissue|kleenex|paper towel|napkin/, '🧻'], [/dish soap|dishwasher|detergent|laundry|bleach|cleaner|sponge|wipes/, '🧽'], [/trash|garbage|bin bag|bags?\b/, '🗑️'], [/foil|wrap|parchment|ziploc|zip/, '🧻'], [/batter(y|ies)/, '🔋'], [/light ?bulb/, '💡'], [/candle/, '🕯️'],
  [/shampoo|conditioner|body wash|lotion|soap|deodorant|razor|shaving/, '🧴'], [/toothpaste|toothbrush|floss|mouthwash/, '🪥'], [/diaper|baby|formula|wipes/, '🍼'], [/vitamin|medicine|ibuprofen|tylenol|bandage|band.?aid/, '💊'], [/pet|dog|cat food|litter/, '🐾'], [/flower|bouquet/, '💐'],
];
const BY_AISLE = { Produce: '🥬', 'Dairy & Eggs': '🥛', 'Meat & Seafood': '🥩', 'Meat & Fish': '🥩', Bakery: '🍞', Pantry: '🥫', Frozen: '🧊', Snacks: '🍿', Beverages: '🥤', Household: '🧻', 'Personal care': '🧴' };
const cache = new Map();
// Older Androids (and the wall display) lack the newest emoji and draw an empty box: detect that by drawing the
// emoji and comparing it with a code point nothing draws, and fall back to the aisle's emoji (or the cart).
let probe = null, blank = null;
const ink = (ctx, ch) => { ctx.clearRect(0, 0, 40, 40); ctx.font = '28px sans-serif'; ctx.textBaseline = 'top'; ctx.fillText(ch, 2, 2); return ctx.getImageData(0, 0, 40, 40).data.join(','); };
const renders = (e) => {
  try {
    if (!probe) { const c = document.createElement('canvas'); c.width = c.height = 40; probe = c.getContext('2d', { willReadFrequently: true }); blank = ink(probe, '\u{10FFFE}'); }
    return ink(probe, e) !== blank;
  } catch (err) { return true; }
};
export function foodIcon(name, cat) {
  const k = String(name || '').toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const hit = WORDS.find((w) => w[0].test(k));
  const pick = [hit && hit[1], BY_AISLE[cat], '🛒'].filter(Boolean);
  const e = pick.find(renders) || '🛒';
  cache.set(k, e);
  return e;
}
