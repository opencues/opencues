/**
 * cues-core benchmark — runs real sentences through the full pipeline
 * with live LLM calls and saves results for comparison.
 *
 * Usage:
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/cues-core-benchmark.ts
 *
 * Results saved to: tests/results/cuescore-{model}-{timestamp}.json
 */

import { buildSourcesFromConfig, combineWordSources } from '../../packages/cues-core/src/sources/build-sources';
import { ClassifiedSourceGroup } from '../../packages/cues-core/src/sources/classified-source-group';
import { createResolver } from '../../packages/cues-core/src/resolver';
import { parseCuesMd } from '../../packages/cues-core/src/cues-md';
import { HttpAdapter, CueContext, CueResult } from '../../packages/cues-core/src/types';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) { console.error('Set GROQ_API_KEY'); process.exit(1); }

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';

// ---------------------------------------------------------------------------
// HTTP adapter (real HTTPS with keep-alive)
// ---------------------------------------------------------------------------

const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });

const httpAdapter: HttpAdapter = {
  post: (url: string, body: string, headers: Record<string, string>) =>
    new Promise((resolve, reject) => {
      // Apply provider overrides matching production NodeHttpAdapter behavior
      const u = new URL(url);
      if (u.hostname === 'api.groq.com') {
        const parsed = JSON.parse(body);
        parsed.reasoning_effort = 'low';
        body = JSON.stringify(parsed);
      }
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent,
      }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    }),
};

// ---------------------------------------------------------------------------
// Build sources from actual config files
// ---------------------------------------------------------------------------

const cwd = path.resolve(__dirname, '../../');
const cuesMdPath = path.join(cwd, 'cues.md');
const blanksMdPath = path.join(cwd, 'blanks.md');

const cuesConfig = fs.existsSync(cuesMdPath)
  ? parseCuesMd(fs.readFileSync(cuesMdPath, 'utf8'))
  : undefined;
const blanksConfig = fs.existsSync(blanksMdPath)
  ? parseCuesMd(fs.readFileSync(blanksMdPath, 'utf8'))
  : undefined;

const options = { httpAdapter, endpoint: ENDPOINT, apiKey: API_KEY, defaultModel: MODEL };
const allSources = buildSourcesFromConfig(cuesConfig, blanksConfig, options);
const resolver = createResolver(allSources, { parallel: false, timeout: 30000, continueOnError: true });

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

interface TestCase {
  category: string;
  input: string;
  /** Word index to check (for words) or blank index (for blanks) */
  checkIndex: number;
  /** At least one of these should appear in alternatives */
  expectedAny: string[];
  /** Description */
  desc: string;
}

const WORD_TESTS: TestCase[] = [
  // --- Adjectives (30) ---
  { category: 'word-adj', input: 'The happy boy ran', checkIndex: 1, expectedAny: ['glad', 'joyful', 'cheerful', 'content', 'pleased', 'sad', 'unhappy', 'delighted', 'ecstatic'], desc: 'happy' },
  { category: 'word-adj', input: 'The big house', checkIndex: 1, expectedAny: ['large', 'huge', 'enormous', 'massive', 'small', 'tiny', 'grand', 'spacious'], desc: 'big' },
  { category: 'word-adj', input: 'The old man', checkIndex: 1, expectedAny: ['elderly', 'aged', 'ancient', 'young', 'senior', 'mature', 'veteran'], desc: 'old' },
  { category: 'word-adj', input: 'A beautiful sunset', checkIndex: 1, expectedAny: ['gorgeous', 'stunning', 'lovely', 'pretty', 'ugly', 'magnificent', 'breathtaking'], desc: 'beautiful' },
  { category: 'word-adj', input: 'The small dog', checkIndex: 1, expectedAny: ['tiny', 'little', 'miniature', 'large', 'big', 'petite', 'compact'], desc: 'small' },
  { category: 'word-adj', input: 'A cold winter', checkIndex: 1, expectedAny: ['freezing', 'chilly', 'icy', 'warm', 'hot', 'bitter', 'frigid', 'harsh'], desc: 'cold' },
  { category: 'word-adj', input: 'The strong wind blew', checkIndex: 1, expectedAny: ['powerful', 'fierce', 'gentle', 'weak', 'mighty', 'intense', 'violent'], desc: 'strong' },
  { category: 'word-adj', input: 'A dark room', checkIndex: 1, expectedAny: ['dim', 'bright', 'gloomy', 'shadowy', 'light', 'murky', 'pitch-black'], desc: 'dark' },
  { category: 'word-adj', input: 'The tall building', checkIndex: 1, expectedAny: ['high', 'towering', 'short', 'massive', 'imposing', 'lofty', 'elevated'], desc: 'tall' },
  { category: 'word-adj', input: 'A fast car', checkIndex: 1, expectedAny: ['quick', 'slow', 'rapid', 'speedy', 'swift'], desc: 'fast' },
  { category: 'word-adj', input: 'The rich man', checkIndex: 1, expectedAny: ['wealthy', 'poor', 'affluent', 'prosperous', 'opulent'], desc: 'rich' },
  { category: 'word-adj', input: 'A quiet room', checkIndex: 1, expectedAny: ['silent', 'loud', 'noisy', 'peaceful', 'calm', 'hushed', 'still'], desc: 'quiet' },
  { category: 'word-adj', input: 'The heavy box', checkIndex: 1, expectedAny: ['light', 'weighty', 'massive', 'bulky', 'dense', 'cumbersome'], desc: 'heavy' },
  { category: 'word-adj', input: 'A bright light', checkIndex: 1, expectedAny: ['dim', 'brilliant', 'vivid', 'dazzling', 'glowing', 'intense', 'faint'], desc: 'bright (light)' },
  { category: 'word-adj', input: 'The narrow path', checkIndex: 1, expectedAny: ['wide', 'thin', 'broad', 'slim', 'tight', 'cramped', 'restricted'], desc: 'narrow' },
  { category: 'word-adj', input: 'A deep ocean', checkIndex: 1, expectedAny: ['shallow', 'vast', 'profound', 'bottomless', 'immense', 'endless'], desc: 'deep' },
  { category: 'word-adj', input: 'The clean kitchen', checkIndex: 1, expectedAny: ['dirty', 'tidy', 'spotless', 'messy', 'pristine', 'immaculate'], desc: 'clean' },
  { category: 'word-adj', input: 'A long road', checkIndex: 1, expectedAny: ['short', 'winding', 'endless', 'straight', 'extended', 'lengthy'], desc: 'long' },
  { category: 'word-adj', input: 'The empty room', checkIndex: 1, expectedAny: ['full', 'vacant', 'bare', 'hollow', 'crowded', 'occupied'], desc: 'empty' },
  { category: 'word-adj', input: 'A new car', checkIndex: 1, expectedAny: ['old', 'fresh', 'brand-new', 'used', 'modern', 'recent', 'novel'], desc: 'new' },
  { category: 'word-adj', input: 'The angry crowd', checkIndex: 1, expectedAny: ['furious', 'calm', 'hostile', 'peaceful', 'enraged', 'irate', 'mad'], desc: 'angry' },
  { category: 'word-adj', input: 'A brave soldier', checkIndex: 1, expectedAny: ['courageous', 'cowardly', 'fearless', 'bold', 'valiant', 'heroic', 'timid'], desc: 'brave' },
  { category: 'word-adj', input: 'The lazy cat slept', checkIndex: 1, expectedAny: ['idle', 'active', 'sluggish', 'energetic', 'lethargic', 'indolent'], desc: 'lazy' },
  { category: 'word-adj', input: 'A wise decision', checkIndex: 1, expectedAny: ['foolish', 'smart', 'clever', 'prudent', 'stupid', 'sound', 'sensible'], desc: 'wise' },
  { category: 'word-adj', input: 'The smooth surface', checkIndex: 1, expectedAny: ['rough', 'flat', 'polished', 'uneven', 'silky', 'sleek', 'bumpy'], desc: 'smooth' },
  { category: 'word-adj', input: 'A dangerous road', checkIndex: 1, expectedAny: ['safe', 'hazardous', 'risky', 'perilous', 'treacherous', 'secure'], desc: 'dangerous' },
  { category: 'word-adj', input: 'The thick fog', checkIndex: 1, expectedAny: ['thin', 'dense', 'heavy', 'light', 'opaque', 'impenetrable'], desc: 'thick' },
  { category: 'word-adj', input: 'A simple task', checkIndex: 1, expectedAny: ['complex', 'easy', 'difficult', 'basic', 'straightforward', 'hard'], desc: 'simple' },
  { category: 'word-adj', input: 'The expensive watch', checkIndex: 1, expectedAny: ['cheap', 'costly', 'pricey', 'affordable', 'luxurious', 'valuable'], desc: 'expensive' },
  { category: 'word-adj', input: 'A dry desert', checkIndex: 1, expectedAny: ['wet', 'arid', 'barren', 'parched', 'scorching', 'desolate'], desc: 'dry' },

  // --- Verbs (30) ---
  { category: 'word-verb', input: 'She walked home', checkIndex: 1, expectedAny: ['ran', 'strolled', 'marched', 'drove', 'sprinted', 'hurried', 'trudged'], desc: 'walked' },
  { category: 'word-verb', input: 'He ran quickly', checkIndex: 1, expectedAny: ['sprinted', 'jogged', 'dashed', 'walked', 'rushed', 'bolted', 'raced'], desc: 'ran' },
  { category: 'word-verb', input: 'They built a house', checkIndex: 1, expectedAny: ['constructed', 'created', 'erected', 'designed', 'destroyed', 'assembled'], desc: 'built' },
  { category: 'word-verb', input: 'I said hello', checkIndex: 1, expectedAny: ['whispered', 'shouted', 'muttered', 'yelled', 'spoke', 'screamed', 'exclaimed'], desc: 'said' },
  { category: 'word-verb', input: 'She ate dinner', checkIndex: 1, expectedAny: ['consumed', 'devoured', 'skipped', 'finished', 'enjoyed', 'prepared', 'cooked'], desc: 'ate' },
  { category: 'word-verb', input: 'He broke the window', checkIndex: 1, expectedAny: ['shattered', 'cracked', 'smashed', 'fixed', 'repaired', 'damaged'], desc: 'broke' },
  { category: 'word-verb', input: 'They found treasure', checkIndex: 1, expectedAny: ['discovered', 'lost', 'uncovered', 'located', 'stumbled upon', 'unearthed'], desc: 'found' },
  { category: 'word-verb', input: 'I wrote a letter', checkIndex: 1, expectedAny: ['typed', 'composed', 'drafted', 'penned', 'scribbled', 'read'], desc: 'wrote' },
  { category: 'word-verb', input: 'She threw the ball', checkIndex: 1, expectedAny: ['tossed', 'hurled', 'caught', 'lobbed', 'pitched', 'flung', 'launched'], desc: 'threw' },
  { category: 'word-verb', input: 'He gave a speech', checkIndex: 1, expectedAny: ['delivered', 'received', 'prepared', 'presented', 'made', 'offered'], desc: 'gave' },
  { category: 'word-verb', input: 'They fought bravely', checkIndex: 1, expectedAny: ['battled', 'surrendered', 'struggled', 'clashed', 'resisted', 'warred'], desc: 'fought' },
  { category: 'word-verb', input: 'She sang beautifully', checkIndex: 1, expectedAny: ['performed', 'hummed', 'chanted', 'crooned', 'whistled', 'screamed'], desc: 'sang' },
  { category: 'word-verb', input: 'He opened the door', checkIndex: 1, expectedAny: ['closed', 'shut', 'unlocked', 'slammed', 'pushed', 'pulled'], desc: 'opened' },
  { category: 'word-verb', input: 'I bought groceries', checkIndex: 1, expectedAny: ['purchased', 'sold', 'ordered', 'grabbed', 'picked up', 'acquired'], desc: 'bought' },
  { category: 'word-verb', input: 'She climbed the mountain', checkIndex: 1, expectedAny: ['ascended', 'descended', 'scaled', 'hiked', 'summited', 'conquered'], desc: 'climbed' },
  { category: 'word-verb', input: 'He studied hard', checkIndex: 1, expectedAny: ['learned', 'practiced', 'reviewed', 'crammed', 'examined', 'worked', 'read'], desc: 'studied' },
  { category: 'word-verb', input: 'They destroyed the evidence', checkIndex: 1, expectedAny: ['preserved', 'eliminated', 'removed', 'concealed', 'shredded', 'burned', 'created'], desc: 'destroyed' },
  { category: 'word-verb', input: 'She laughed loudly', checkIndex: 1, expectedAny: ['giggled', 'chuckled', 'cried', 'snickered', 'roared', 'howled', 'sobbed'], desc: 'laughed' },
  { category: 'word-verb', input: 'He carried the box', checkIndex: 1, expectedAny: ['lifted', 'dropped', 'hauled', 'moved', 'dragged', 'transported', 'held'], desc: 'carried' },
  { category: 'word-verb', input: 'I chose the blue one', checkIndex: 1, expectedAny: ['selected', 'picked', 'rejected', 'preferred', 'grabbed', 'took'], desc: 'chose' },
  { category: 'word-verb', input: 'She painted the wall', checkIndex: 1, expectedAny: ['decorated', 'drew', 'colored', 'coated', 'covered', 'stained'], desc: 'painted' },
  { category: 'word-verb', input: 'He taught the class', checkIndex: 1, expectedAny: ['instructed', 'educated', 'learned', 'trained', 'tutored', 'led', 'lectured'], desc: 'taught' },
  { category: 'word-verb', input: 'They promised to return', checkIndex: 1, expectedAny: ['vowed', 'swore', 'pledged', 'refused', 'agreed', 'guaranteed'], desc: 'promised' },
  { category: 'word-verb', input: 'She whispered softly', checkIndex: 1, expectedAny: ['murmured', 'shouted', 'mumbled', 'hissed', 'muttered', 'spoke', 'breathed'], desc: 'whispered' },
  { category: 'word-verb', input: 'He pushed the cart', checkIndex: 1, expectedAny: ['pulled', 'shoved', 'dragged', 'moved', 'wheeled', 'rolled'], desc: 'pushed' },
  { category: 'word-verb', input: 'They celebrated victory', checkIndex: 1, expectedAny: ['mourned', 'enjoyed', 'cheered', 'honored', 'marked', 'toasted'], desc: 'celebrated' },
  { category: 'word-verb', input: 'She grabbed the rope', checkIndex: 1, expectedAny: ['seized', 'released', 'clutched', 'snatched', 'caught', 'held', 'dropped'], desc: 'grabbed' },
  { category: 'word-verb', input: 'He decided quickly', checkIndex: 1, expectedAny: ['chose', 'hesitated', 'determined', 'resolved', 'concluded', 'picked'], desc: 'decided' },
  { category: 'word-verb', input: 'I remembered the song', checkIndex: 1, expectedAny: ['forgot', 'recalled', 'recognized', 'hummed', 'recollected'], desc: 'remembered' },
  { category: 'word-verb', input: 'She accepted the offer', checkIndex: 1, expectedAny: ['rejected', 'declined', 'received', 'took', 'embraced', 'refused'], desc: 'accepted' },

  // --- Nouns (15) ---
  { category: 'word-noun', input: 'The dog barked', checkIndex: 1, expectedAny: ['cat', 'hound', 'puppy', 'wolf', 'animal', 'mutt'], desc: 'dog' },
  { category: 'word-noun', input: 'The car stopped', checkIndex: 1, expectedAny: ['vehicle', 'truck', 'bus', 'train', 'van', 'automobile'], desc: 'car' },
  { category: 'word-noun', input: 'The teacher spoke', checkIndex: 1, expectedAny: ['professor', 'instructor', 'student', 'lecturer', 'mentor', 'educator'], desc: 'teacher' },
  { category: 'word-noun', input: 'The house collapsed', checkIndex: 1, expectedAny: ['building', 'structure', 'home', 'tower', 'wall', 'roof'], desc: 'house' },
  { category: 'word-noun', input: 'The child cried', checkIndex: 1, expectedAny: ['baby', 'boy', 'girl', 'kid', 'toddler', 'infant', 'adult'], desc: 'child' },
  { category: 'word-noun', input: 'The king ruled', checkIndex: 1, expectedAny: ['queen', 'emperor', 'prince', 'ruler', 'monarch', 'dictator'], desc: 'king' },
  { category: 'word-noun', input: 'The river flowed', checkIndex: 1, expectedAny: ['stream', 'creek', 'water', 'ocean', 'lake', 'canal'], desc: 'river' },
  { category: 'word-noun', input: 'The sword gleamed', checkIndex: 1, expectedAny: ['blade', 'knife', 'dagger', 'weapon', 'spear', 'shield'], desc: 'sword' },
  { category: 'word-noun', input: 'The mountain loomed', checkIndex: 1, expectedAny: ['hill', 'peak', 'cliff', 'volcano', 'ridge', 'summit'], desc: 'mountain' },
  { category: 'word-noun', input: 'The city bustled', checkIndex: 1, expectedAny: ['town', 'village', 'metropolis', 'suburb', 'capital', 'country'], desc: 'city' },
  { category: 'word-noun', input: 'The doctor arrived', checkIndex: 1, expectedAny: ['nurse', 'surgeon', 'physician', 'patient', 'medic', 'specialist'], desc: 'doctor' },
  { category: 'word-noun', input: 'The ship sailed', checkIndex: 1, expectedAny: ['boat', 'vessel', 'yacht', 'submarine', 'ferry', 'craft'], desc: 'ship' },
  { category: 'word-noun', input: 'The forest burned', checkIndex: 1, expectedAny: ['jungle', 'woods', 'trees', 'field', 'meadow', 'wilderness'], desc: 'forest' },
  { category: 'word-noun', input: 'The storm raged', checkIndex: 1, expectedAny: ['hurricane', 'tempest', 'blizzard', 'tornado', 'typhoon', 'wind', 'rain'], desc: 'storm' },
  { category: 'word-noun', input: 'The army advanced', checkIndex: 1, expectedAny: ['troops', 'soldiers', 'forces', 'battalion', 'enemy', 'fleet', 'militia'], desc: 'army' },
];

const BLANK_MATH_TESTS: TestCase[] = [
  // Basic operations
  { category: 'blank-math', input: '4 * 12 = _', checkIndex: -1, expectedAny: ['48'], desc: '4*12' },
  { category: 'blank-math', input: '100 / 4 = _', checkIndex: -1, expectedAny: ['25'], desc: '100/4' },
  { category: 'blank-math', input: '7 + 8 = _', checkIndex: -1, expectedAny: ['15'], desc: '7+8' },
  { category: 'blank-math', input: '50 - 17 = _', checkIndex: -1, expectedAny: ['33'], desc: '50-17' },
  { category: 'blank-math', input: '2 * 2 * 2 = _', checkIndex: -1, expectedAny: ['8'], desc: '2*2*2' },
  { category: 'blank-math', input: '99 + 1 = _', checkIndex: -1, expectedAny: ['100'], desc: '99+1' },
  { category: 'blank-math', input: '15 * 15 = _', checkIndex: -1, expectedAny: ['225'], desc: '15*15' },
  { category: 'blank-math', input: '1000 - 1 = _', checkIndex: -1, expectedAny: ['999'], desc: '1000-1' },
  { category: 'blank-math', input: '81 / 9 = _', checkIndex: -1, expectedAny: ['9'], desc: '81/9' },
  { category: 'blank-math', input: '25 + 75 = _', checkIndex: -1, expectedAny: ['100'], desc: '25+75' },
  // Larger numbers
  { category: 'blank-math', input: '123 + 456 = _', checkIndex: -1, expectedAny: ['579'], desc: '123+456' },
  { category: 'blank-math', input: '999 - 500 = _', checkIndex: -1, expectedAny: ['499'], desc: '999-500' },
  { category: 'blank-math', input: '12 * 12 = _', checkIndex: -1, expectedAny: ['144'], desc: '12*12' },
  { category: 'blank-math', input: '200 / 8 = _', checkIndex: -1, expectedAny: ['25'], desc: '200/8' },
  { category: 'blank-math', input: '33 * 3 = _', checkIndex: -1, expectedAny: ['99'], desc: '33*3' },
  // Keywords
  { category: 'blank-math', input: 'half of 16 = _', checkIndex: -1, expectedAny: ['8'], desc: 'half of 16' },
  { category: 'blank-math', input: 'double 25 = _', checkIndex: -1, expectedAny: ['50'], desc: 'double 25' },
  { category: 'blank-math', input: 'triple 7 = _', checkIndex: -1, expectedAny: ['21'], desc: 'triple 7' },
  { category: 'blank-math', input: 'half of 100 = _', checkIndex: -1, expectedAny: ['50'], desc: 'half of 100' },
  { category: 'blank-math', input: 'double 50 = _', checkIndex: -1, expectedAny: ['100'], desc: 'double 50' },
  // Expressions with parentheses
  { category: 'blank-math', input: '10 + 20 * 3 = _', checkIndex: -1, expectedAny: ['70', '90'], desc: '10+20*3' },
  { category: 'blank-math', input: '5 * 5 + 5 = _', checkIndex: -1, expectedAny: ['30'], desc: '5*5+5' },
  { category: 'blank-math', input: '100 - 25 * 2 = _', checkIndex: -1, expectedAny: ['50'], desc: '100-25*2' },
  // Percentages/practical
  { category: 'blank-math', input: '50 + 50 = _', checkIndex: -1, expectedAny: ['100'], desc: '50+50' },
  { category: 'blank-math', input: '1 + 2 + 3 + 4 = _', checkIndex: -1, expectedAny: ['10'], desc: '1+2+3+4' },
  { category: 'blank-math', input: '9 * 9 = _', checkIndex: -1, expectedAny: ['81'], desc: '9*9' },
  { category: 'blank-math', input: '7 * 7 = _', checkIndex: -1, expectedAny: ['49'], desc: '7*7' },
  { category: 'blank-math', input: '6 * 8 = _', checkIndex: -1, expectedAny: ['48'], desc: '6*8' },
  { category: 'blank-math', input: '11 * 11 = _', checkIndex: -1, expectedAny: ['121'], desc: '11*11' },
  { category: 'blank-math', input: '144 / 12 = _', checkIndex: -1, expectedAny: ['12'], desc: '144/12' },
];

const BLANK_FACTUAL_TESTS: TestCase[] = [
  // Capitals
  { category: 'blank-factual', input: 'The capital of France is _', checkIndex: -1, expectedAny: ['Paris'], desc: 'capital of France' },
  { category: 'blank-factual', input: 'The capital of Japan is _', checkIndex: -1, expectedAny: ['Tokyo'], desc: 'capital of Japan' },
  { category: 'blank-factual', input: 'The capital of Germany is _', checkIndex: -1, expectedAny: ['Berlin'], desc: 'capital of Germany' },
  { category: 'blank-factual', input: 'The capital of Italy is _', checkIndex: -1, expectedAny: ['Rome', 'Roma'], desc: 'capital of Italy' },
  { category: 'blank-factual', input: 'The capital of Australia is _', checkIndex: -1, expectedAny: ['Canberra'], desc: 'capital of Australia' },
  { category: 'blank-factual', input: 'The capital of Brazil is _', checkIndex: -1, expectedAny: ['Brasilia', 'Brasília'], desc: 'capital of Brazil' },
  { category: 'blank-factual', input: 'The capital of Canada is _', checkIndex: -1, expectedAny: ['Ottawa'], desc: 'capital of Canada' },
  { category: 'blank-factual', input: 'The capital of Egypt is _', checkIndex: -1, expectedAny: ['Cairo'], desc: 'capital of Egypt' },
  { category: 'blank-factual', input: 'The capital of Spain is _', checkIndex: -1, expectedAny: ['Madrid'], desc: 'capital of Spain' },
  { category: 'blank-factual', input: 'The capital of India is _', checkIndex: -1, expectedAny: ['New Delhi', 'Delhi'], desc: 'capital of India' },
  // People
  { category: 'blank-factual', input: 'The CEO of Apple is _', checkIndex: -1, expectedAny: ['Tim Cook'], desc: 'CEO of Apple' },
  { category: 'blank-factual', input: 'The author of Harry Potter is _', checkIndex: -1, expectedAny: ['J.K. Rowling', 'Rowling', 'JK Rowling'], desc: 'author of HP' },
  { category: 'blank-factual', input: 'The founder of Microsoft is _', checkIndex: -1, expectedAny: ['Bill Gates', 'Gates'], desc: 'founder of MSFT' },
  { category: 'blank-factual', input: 'The founder of Amazon is _', checkIndex: -1, expectedAny: ['Jeff Bezos', 'Bezos'], desc: 'founder of Amazon' },
  { category: 'blank-factual', input: 'The CEO of Tesla is _', checkIndex: -1, expectedAny: ['Elon Musk', 'Musk'], desc: 'CEO of Tesla' },
  { category: 'blank-factual', input: 'The author of 1984 is _', checkIndex: -1, expectedAny: ['George Orwell', 'Orwell'], desc: 'author of 1984' },
  { category: 'blank-factual', input: 'The founder of Apple is _', checkIndex: -1, expectedAny: ['Steve Jobs', 'Jobs'], desc: 'founder of Apple' },
  { category: 'blank-factual', input: 'The author of Romeo and Juliet is _', checkIndex: -1, expectedAny: ['Shakespeare', 'William Shakespeare'], desc: 'author of R&J' },
  // Science
  { category: 'blank-factual', input: 'The chemical symbol for gold is _', checkIndex: -1, expectedAny: ['Au'], desc: 'symbol for gold' },
  { category: 'blank-factual', input: 'The chemical symbol for iron is _', checkIndex: -1, expectedAny: ['Fe'], desc: 'symbol for iron' },
  { category: 'blank-factual', input: 'The chemical symbol for silver is _', checkIndex: -1, expectedAny: ['Ag'], desc: 'symbol for silver' },
  // Geography/superlatives
  { category: 'blank-factual', input: 'The largest ocean is the _', checkIndex: -1, expectedAny: ['Pacific'], desc: 'largest ocean' },
  { category: 'blank-factual', input: 'The tallest mountain is _', checkIndex: -1, expectedAny: ['Everest', 'Mount Everest', 'Mt. Everest'], desc: 'tallest mountain' },
  { category: 'blank-factual', input: 'The longest river is the _', checkIndex: -1, expectedAny: ['Nile', 'Amazon'], desc: 'longest river' },
  { category: 'blank-factual', input: 'The largest planet is _', checkIndex: -1, expectedAny: ['Jupiter'], desc: 'largest planet' },
  // Dates
  { category: 'blank-factual', input: 'who was the first president of the US _', checkIndex: -1, expectedAny: ['George Washington', 'Washington'], desc: 'first US president' },
  { category: 'blank-factual', input: 'who was the inventor of the telephone _', checkIndex: -1, expectedAny: ['Alexander Graham Bell', 'Bell', 'Graham Bell'], desc: 'telephone inventor' },
  { category: 'blank-factual', input: 'who is the CEO of Google _', checkIndex: -1, expectedAny: ['Sundar Pichai', 'Pichai'], desc: 'CEO of Google' },
  { category: 'blank-factual', input: 'who was the painter of the Mona Lisa _', checkIndex: -1, expectedAny: ['Leonardo da Vinci', 'Da Vinci', 'Leonardo'], desc: 'Mona Lisa painter' },
  { category: 'blank-factual', input: 'who is the founder of Facebook _', checkIndex: -1, expectedAny: ['Mark Zuckerberg', 'Zuckerberg'], desc: 'founder of Facebook' },
];

const BLANK_GRAMMAR_TESTS: TestCase[] = [
  // Blank at end → nouns/destinations
  { category: 'blank-grammar', input: 'The boy vaulted over the _', checkIndex: 5, expectedAny: ['fence', 'wall', 'hedge', 'gate', 'hurdle', 'barrier', 'railing', 'obstacle'], desc: 'vaulted over NOUN' },
  { category: 'blank-grammar', input: 'We are going to _', checkIndex: 4, expectedAny: ['Paris', 'school', 'work', 'London', 'home', 'Tokyo', 'eat', 'leave', 'sleep'], desc: 'going to DEST' },
  { category: 'blank-grammar', input: 'The code is written in _', checkIndex: 5, expectedAny: ['Python', 'Java', 'C++', 'Rust', 'Go', 'JavaScript', 'TypeScript', 'Ruby'], desc: 'written in LANG' },
  { category: 'blank-grammar', input: 'He felt extremely _', checkIndex: 3, expectedAny: ['happy', 'sad', 'tired', 'nervous', 'anxious', 'excited', 'angry', 'grateful', 'lonely'], desc: 'felt extremely ADJ' },
  { category: 'blank-grammar', input: 'She works at _', checkIndex: 3, expectedAny: ['Google', 'home', 'night', 'school', 'hospital', 'Amazon', 'Microsoft', 'Apple'], desc: 'works at PLACE' },
  { category: 'blank-grammar', input: 'The cat sat on the _', checkIndex: 5, expectedAny: ['mat', 'chair', 'floor', 'table', 'sofa', 'bed', 'rug', 'couch', 'roof', 'windowsill'], desc: 'sat on NOUN' },
  { category: 'blank-grammar', input: 'I want to learn _', checkIndex: 4, expectedAny: ['Python', 'piano', 'guitar', 'Spanish', 'cooking', 'French', 'swimming', 'coding'], desc: 'learn WHAT' },
  { category: 'blank-grammar', input: 'They traveled to _', checkIndex: 3, expectedAny: ['Paris', 'Tokyo', 'London', 'Rome', 'Europe', 'Italy', 'Japan', 'Spain'], desc: 'traveled to DEST' },
  { category: 'blank-grammar', input: 'The dinner was _', checkIndex: 3, expectedAny: ['delicious', 'terrible', 'amazing', 'cold', 'ready', 'served', 'wonderful', 'perfect'], desc: 'dinner was ADJ' },
  { category: 'blank-grammar', input: 'He dreams of _', checkIndex: 3, expectedAny: ['success', 'flying', 'freedom', 'wealth', 'home', 'traveling', 'adventure', 'peace'], desc: 'dreams of NOUN' },

  // Blank at start → subjects
  { category: 'blank-grammar', input: '_ ran across the street', checkIndex: 0, expectedAny: ['He', 'She', 'They', 'Someone', 'It', 'A', 'The'], desc: 'SUBJ ran across' },
  { category: 'blank-grammar', input: '_ walked into the room', checkIndex: 0, expectedAny: ['He', 'She', 'They', 'Someone', 'A', 'The'], desc: 'SUBJ walked in' },
  { category: 'blank-grammar', input: '_ crashed into the wall', checkIndex: 0, expectedAny: ['It', 'He', 'She', 'The car', 'A truck', 'Someone', 'The'], desc: 'SUBJ crashed' },
  { category: 'blank-grammar', input: '_ flew over the mountain', checkIndex: 0, expectedAny: ['It', 'He', 'She', 'The bird', 'A plane', 'They', 'The'], desc: 'SUBJ flew over' },
  { category: 'blank-grammar', input: '_ screamed loudly', checkIndex: 0, expectedAny: ['He', 'She', 'They', 'Someone', 'The', 'A'], desc: 'SUBJ screamed' },

  // Blank in middle → adjectives/verbs/adverbs
  { category: 'blank-grammar', input: 'The _ dog barked loudly', checkIndex: 1, expectedAny: ['big', 'small', 'brown', 'old', 'little', 'angry', 'large', 'black', 'young', 'stray'], desc: 'ADJ dog barked' },
  { category: 'blank-grammar', input: 'She walked _ to school', checkIndex: 2, expectedAny: ['slowly', 'quickly', 'carefully', 'briskly', 'happily', 'alone', 'home', 'fast'], desc: 'walked ADV to school' },
  { category: 'blank-grammar', input: 'The team _ convincingly', checkIndex: 2, expectedAny: ['won', 'lost', 'played', 'performed', 'dominated', 'argued', 'competed'], desc: 'team VERB convincingly' },
  { category: 'blank-grammar', input: 'The _ car raced down the highway', checkIndex: 1, expectedAny: ['fast', 'red', 'blue', 'new', 'old', 'stolen', 'black', 'sleek', 'sports'], desc: 'ADJ car raced' },
  { category: 'blank-grammar', input: 'A _ woman entered the building', checkIndex: 1, expectedAny: ['tall', 'young', 'old', 'beautiful', 'mysterious', 'short', 'blonde', 'elderly'], desc: 'ADJ woman entered' },
  { category: 'blank-grammar', input: 'The students _ the exam', checkIndex: 2, expectedAny: ['passed', 'failed', 'took', 'finished', 'aced', 'completed', 'studied for'], desc: 'students VERB exam' },
  { category: 'blank-grammar', input: 'He _ the ball over the fence', checkIndex: 1, expectedAny: ['threw', 'kicked', 'hit', 'tossed', 'lobbed', 'launched', 'hurled'], desc: 'VERB ball over fence' },
  { category: 'blank-grammar', input: 'The _ sky indicated rain', checkIndex: 1, expectedAny: ['dark', 'gray', 'cloudy', 'grey', 'overcast', 'gloomy', 'stormy'], desc: 'ADJ sky rain' },
  { category: 'blank-grammar', input: 'She _ the piano beautifully', checkIndex: 1, expectedAny: ['played', 'performed', 'practiced', 'touched', 'strummed'], desc: 'VERB piano' },
  { category: 'blank-grammar', input: 'The _ river flows through the valley', checkIndex: 1, expectedAny: ['wide', 'long', 'deep', 'narrow', 'ancient', 'mighty', 'great', 'winding'], desc: 'ADJ river valley' },

  // Preposition context → specific nouns
  { category: 'blank-grammar', input: 'She built the app using _', checkIndex: 5, expectedAny: ['React', 'Python', 'Flutter', 'Swift', 'JavaScript', 'TypeScript', 'Java', 'Vue', 'Angular', 'Rails'], desc: 'app using TECH' },
  { category: 'blank-grammar', input: 'He ate breakfast with _', checkIndex: 4, expectedAny: ['friends', 'family', 'coffee', 'cereal', 'toast', 'enthusiasm', 'joy'], desc: 'breakfast with NOUN' },
  { category: 'blank-grammar', input: 'The book was written by _', checkIndex: 5, expectedAny: ['Shakespeare', 'Tolkien', 'Orwell', 'Hemingway', 'Twain', 'Dickens', 'a', 'an', 'the', 'her', 'him'], desc: 'written by AUTHOR' },
  { category: 'blank-grammar', input: 'They arrived in _', checkIndex: 3, expectedAny: ['time', 'Paris', 'London', 'style', 'silence', 'Tokyo', 'Rome', 'minutes', 'January'], desc: 'arrived in NOUN' },
  { category: 'blank-grammar', input: 'The painting hangs in the _', checkIndex: 5, expectedAny: ['museum', 'gallery', 'hall', 'room', 'office', 'lobby', 'living room', 'bedroom'], desc: 'hangs in PLACE' },
];

const WORD_FINANCIAL_TESTS: TestCase[] = [
  // Pure financial terms
  { category: 'word-finance', input: 'The equity increased', checkIndex: 1, expectedAny: ['stock', 'shares', 'ownership', 'stake', 'debt', 'capital'], desc: 'equity' },
  { category: 'word-finance', input: 'The dividend was paid', checkIndex: 1, expectedAny: ['payout', 'distribution', 'yield', 'return', 'interest', 'payment'], desc: 'dividend' },
  { category: 'word-finance', input: 'His portfolio grew', checkIndex: 1, expectedAny: ['holdings', 'investments', 'assets', 'fund', 'collection', 'account'], desc: 'portfolio' },
  { category: 'word-finance', input: 'The leverage was high', checkIndex: 1, expectedAny: ['debt', 'borrowing', 'margin', 'gearing', 'exposure', 'risk'], desc: 'leverage' },
  { category: 'word-finance', input: 'The hedge protected', checkIndex: 1, expectedAny: ['protection', 'insurance', 'safeguard', 'shield', 'buffer', 'offset'], desc: 'hedge' },
  { category: 'word-finance', input: 'The yield dropped', checkIndex: 1, expectedAny: ['return', 'interest', 'rate', 'profit', 'income', 'dividend'], desc: 'yield' },
  { category: 'word-finance', input: 'Check the liquidity', checkIndex: 2, expectedAny: ['cash flow', 'solvency', 'availability', 'fluidity', 'convertibility', 'cash'], desc: 'liquidity' },
  { category: 'word-finance', input: 'The depreciation accelerated', checkIndex: 1, expectedAny: ['decline', 'devaluation', 'amortization', 'write-down', 'loss', 'appreciation'], desc: 'depreciation' },
  { category: 'word-finance', input: 'The collateral was seized', checkIndex: 1, expectedAny: ['security', 'guarantee', 'asset', 'pledge', 'surety', 'deposit'], desc: 'collateral' },
  { category: 'word-finance', input: 'The arbitrage opportunity', checkIndex: 1, expectedAny: ['trading', 'speculation', 'opportunity', 'profit', 'exploit', 'spread'], desc: 'arbitrage' },
  // Financial in context
  { category: 'word-finance', input: 'The securities were traded', checkIndex: 1, expectedAny: ['stocks', 'bonds', 'assets', 'instruments', 'shares', 'holdings'], desc: 'securities' },
  { category: 'word-finance', input: 'The derivative expired', checkIndex: 1, expectedAny: ['option', 'contract', 'future', 'swap', 'instrument', 'warrant'], desc: 'derivative' },
  { category: 'word-finance', input: 'The amortization schedule', checkIndex: 1, expectedAny: ['repayment', 'depreciation', 'payment', 'installment', 'write-off', 'payoff'], desc: 'amortization' },
  // Mixed financial + general
  { category: 'word-finance', input: 'The portfolio lost equity value', checkIndex: 1, expectedAny: ['holdings', 'investments', 'assets', 'fund', 'account'], desc: 'portfolio in context' },
  { category: 'word-finance', input: 'The hedge fund leveraged derivatives', checkIndex: 3, expectedAny: ['options', 'contracts', 'futures', 'swaps', 'instruments', 'securities'], desc: 'derivatives in context' },
];

const BLANK_TRANSLATION_TESTS: TestCase[] = [
  // French
  { category: 'blank-translate', input: 'Hello in French is _', checkIndex: -1, expectedAny: ['Bonjour', 'bonjour', 'Salut'], desc: 'hello → French' },
  { category: 'blank-translate', input: 'Goodbye in French is _', checkIndex: -1, expectedAny: ['Au revoir', 'au revoir', 'Adieu'], desc: 'goodbye → French' },
  { category: 'blank-translate', input: 'Bread in French is _', checkIndex: -1, expectedAny: ['Pain', 'pain'], desc: 'bread → French' },
  { category: 'blank-translate', input: 'Water in French is _', checkIndex: -1, expectedAny: ['Eau', 'eau'], desc: 'water → French' },
  { category: 'blank-translate', input: 'Thank you in French is _', checkIndex: -1, expectedAny: ['Merci', 'merci'], desc: 'thank you → French' },
  // Spanish
  { category: 'blank-translate', input: 'Dog in Spanish is _', checkIndex: -1, expectedAny: ['Perro', 'perro'], desc: 'dog → Spanish' },
  { category: 'blank-translate', input: 'Cat in Spanish is _', checkIndex: -1, expectedAny: ['Gato', 'gato'], desc: 'cat → Spanish' },
  { category: 'blank-translate', input: 'Red in Spanish is _', checkIndex: -1, expectedAny: ['Rojo', 'rojo'], desc: 'red → Spanish' },
  { category: 'blank-translate', input: 'House in Spanish is _', checkIndex: -1, expectedAny: ['Casa', 'casa'], desc: 'house → Spanish' },
  { category: 'blank-translate', input: 'Good morning in Spanish is _', checkIndex: -1, expectedAny: ['Buenos dias', 'Buenos días', 'buenos dias'], desc: 'good morning → Spanish' },
  // German
  { category: 'blank-translate', input: 'The German word for house is _', checkIndex: -1, expectedAny: ['Haus', 'haus'], desc: 'house → German' },
  { category: 'blank-translate', input: 'Book in German is _', checkIndex: -1, expectedAny: ['Buch', 'buch'], desc: 'book → German' },
  { category: 'blank-translate', input: 'Water in German is _', checkIndex: -1, expectedAny: ['Wasser', 'wasser'], desc: 'water → German' },
  { category: 'blank-translate', input: 'Thank you in German is _', checkIndex: -1, expectedAny: ['Danke', 'danke'], desc: 'thank you → German' },
  { category: 'blank-translate', input: 'Good night in German is _', checkIndex: -1, expectedAny: ['Gute Nacht', 'gute Nacht', 'gute nacht'], desc: 'good night → German' },
  // Italian
  { category: 'blank-translate', input: 'How do you say goodbye in Italian _', checkIndex: -1, expectedAny: ['Arrivederci', 'arrivederci', 'Ciao', 'ciao'], desc: 'goodbye → Italian' },
  { category: 'blank-translate', input: 'Love in Italian is _', checkIndex: -1, expectedAny: ['Amore', 'amore'], desc: 'love → Italian' },
  { category: 'blank-translate', input: 'Friend in Italian is _', checkIndex: -1, expectedAny: ['Amico', 'amico', 'Amica'], desc: 'friend → Italian' },
  // Japanese (romanized)
  { category: 'blank-translate', input: 'Thank you in Japanese is _', checkIndex: -1, expectedAny: ['Arigatou', 'arigatou', 'Arigato', 'arigato', 'Arigatō'], desc: 'thank you → Japanese' },
  { category: 'blank-translate', input: 'Hello in Japanese is _', checkIndex: -1, expectedAny: ['Konnichiwa', 'konnichiwa', 'Konnichi wa'], desc: 'hello → Japanese' },
  // Portuguese
  { category: 'blank-translate', input: 'Cat in Portuguese is _', checkIndex: -1, expectedAny: ['Gato', 'gato'], desc: 'cat → Portuguese' },
  { category: 'blank-translate', input: 'Thank you in Portuguese is _', checkIndex: -1, expectedAny: ['Obrigado', 'obrigado', 'Obrigada'], desc: 'thank you → Portuguese' },
  // Latin
  { category: 'blank-translate', input: 'Love in Latin is _', checkIndex: -1, expectedAny: ['Amor', 'amor'], desc: 'love → Latin' },
  { category: 'blank-translate', input: 'Peace in Latin is _', checkIndex: -1, expectedAny: ['Pax', 'pax'], desc: 'peace → Latin' },
  // Korean (romanized)
  { category: 'blank-translate', input: 'Friend in Korean is _', checkIndex: -1, expectedAny: ['Chingu', 'chingu', 'Chin-gu', 'Chingoo'], desc: 'friend → Korean' },
  // Arabic (romanized)
  { category: 'blank-translate', input: 'Peace in Arabic is _', checkIndex: -1, expectedAny: ['Salaam', 'salaam', 'Salam', 'salam'], desc: 'peace → Arabic' },
  // Russian (romanized)
  { category: 'blank-translate', input: 'Hello in Russian is _', checkIndex: -1, expectedAny: ['Privet', 'privet', 'Zdravstvuyte', 'Zdrastvuyte'], desc: 'hello → Russian' },
  // Hebrew
  { category: 'blank-translate', input: 'Peace in Hebrew is _', checkIndex: -1, expectedAny: ['Shalom', 'shalom'], desc: 'peace → Hebrew' },
  // Chinese (romanized)
  { category: 'blank-translate', input: 'Thank you in Chinese is _', checkIndex: -1, expectedAny: ['Xie xie', 'xie xie', 'Xiexie', 'xiexie', 'Xièxiè'], desc: 'thank you → Chinese' },
  // Cross-check: non-translation with language word shouldn't route here
  { category: 'blank-translate', input: 'The French word for beautiful is _', checkIndex: -1, expectedAny: ['Belle', 'belle', 'Beau', 'beau', 'Magnifique'], desc: 'beautiful → French' },
];

const BLANK_UNIT_TESTS: TestCase[] = [
  // Celsius ↔ Fahrenheit
  { category: 'blank-unit', input: '100 celsius in fahrenheit is _', checkIndex: -1, expectedAny: ['212'], desc: '100C→F' },
  { category: 'blank-unit', input: '0 celsius in fahrenheit is _', checkIndex: -1, expectedAny: ['32'], desc: '0C→F' },
  { category: 'blank-unit', input: '37 celsius in fahrenheit is _', checkIndex: -1, expectedAny: ['98.6', '98'], desc: '37C→F (body temp)' },
  { category: 'blank-unit', input: '32 fahrenheit in celsius is _', checkIndex: -1, expectedAny: ['0'], desc: '32F→C' },
  { category: 'blank-unit', input: '212 fahrenheit in celsius is _', checkIndex: -1, expectedAny: ['100'], desc: '212F→C' },
  // Miles ↔ Km
  { category: 'blank-unit', input: '1 miles in km is _', checkIndex: -1, expectedAny: ['1.6093', '1.609', '1.61'], desc: '1mi→km' },
  { category: 'blank-unit', input: '5 miles in km is _', checkIndex: -1, expectedAny: ['8.0467', '8.047', '8.05', '8'], desc: '5mi→km' },
  { category: 'blank-unit', input: '10 km in miles is _', checkIndex: -1, expectedAny: ['6.2137', '6.214', '6.21', '6'], desc: '10km→mi' },
  { category: 'blank-unit', input: '100 km in miles is _', checkIndex: -1, expectedAny: ['62.1371', '62.137', '62.14', '62'], desc: '100km→mi' },
  { category: 'blank-unit', input: '26 miles in km is _', checkIndex: -1, expectedAny: ['41.8428', '41.843', '41.84', '42'], desc: '26mi→km (marathon)' },
  // Kg ↔ Pounds
  { category: 'blank-unit', input: '1 kg in pounds is _', checkIndex: -1, expectedAny: ['2.2046', '2.205', '2.2'], desc: '1kg→lb' },
  { category: 'blank-unit', input: '70 kg in pounds is _', checkIndex: -1, expectedAny: ['154.3234', '154.323', '154.32', '154'], desc: '70kg→lb' },
  { category: 'blank-unit', input: '100 pounds in kg is _', checkIndex: -1, expectedAny: ['45.3592', '45.359', '45.36', '45'], desc: '100lb→kg' },
  { category: 'blank-unit', input: '200 pounds in kg is _', checkIndex: -1, expectedAny: ['90.7184', '90.718', '90.72', '91'], desc: '200lb→kg' },
  // Meters ↔ Feet
  { category: 'blank-unit', input: '1 meters in feet is _', checkIndex: -1, expectedAny: ['3.2808', '3.281', '3.28'], desc: '1m→ft' },
  { category: 'blank-unit', input: '10 meters in feet is _', checkIndex: -1, expectedAny: ['32.8084', '32.808', '32.81', '33'], desc: '10m→ft' },
  { category: 'blank-unit', input: '6 feet in meters is _', checkIndex: -1, expectedAny: ['1.8288', '1.829', '1.83'], desc: '6ft→m' },
  { category: 'blank-unit', input: '100 feet in meters is _', checkIndex: -1, expectedAny: ['30.48', '30.5'], desc: '100ft→m' },
  // Inches ↔ cm
  { category: 'blank-unit', input: '1 inches in cm is _', checkIndex: -1, expectedAny: ['2.54'], desc: '1in→cm' },
  { category: 'blank-unit', input: '12 inches in cm is _', checkIndex: -1, expectedAny: ['30.48', '30.5'], desc: '12in→cm' },
  { category: 'blank-unit', input: '10 cm in inches is _', checkIndex: -1, expectedAny: ['3.937', '3.94', '4'], desc: '10cm→in' },
  // Liters ↔ Gallons
  { category: 'blank-unit', input: '1 liters in gallons is _', checkIndex: -1, expectedAny: ['0.2642', '0.264', '0.26'], desc: '1L→gal' },
  { category: 'blank-unit', input: '10 liters in gallons is _', checkIndex: -1, expectedAny: ['2.6417', '2.642', '2.64'], desc: '10L→gal' },
  { category: 'blank-unit', input: '1 gallons in liters is _', checkIndex: -1, expectedAny: ['3.7854', '3.785', '3.79'], desc: '1gal→L' },
  // Yards ↔ Meters
  { category: 'blank-unit', input: '100 yards in meters is _', checkIndex: -1, expectedAny: ['91.44', '91.4', '91'], desc: '100yd→m' },
  // Ounces ↔ Grams
  { category: 'blank-unit', input: '1 oz in grams is _', checkIndex: -1, expectedAny: ['28.3495', '28.35', '28'], desc: '1oz→g' },
  { category: 'blank-unit', input: '16 oz in grams is _', checkIndex: -1, expectedAny: ['453.592', '453.59', '454'], desc: '16oz→g (1lb)' },
  // Edge cases
  { category: 'blank-unit', input: '0 miles in km is _', checkIndex: -1, expectedAny: ['0'], desc: '0mi→km' },
  { category: 'blank-unit', input: '0 celsius in fahrenheit is _', checkIndex: -1, expectedAny: ['32'], desc: '0C→F (dup check)' },
  { category: 'blank-unit', input: '50 meters in feet is _', checkIndex: -1, expectedAny: ['164.042', '164.04', '164'], desc: '50m→ft' },
];

const BLANK_SPELLING_TESTS: TestCase[] = [
  // Opposites
  { category: 'blank-spell', input: 'The opposite of hot is _', checkIndex: -1, expectedAny: ['cold', 'cool'], desc: 'opposite: hot' },
  { category: 'blank-spell', input: 'The opposite of big is _', checkIndex: -1, expectedAny: ['small', 'little', 'tiny'], desc: 'opposite: big' },
  { category: 'blank-spell', input: 'The opposite of fast is _', checkIndex: -1, expectedAny: ['slow'], desc: 'opposite: fast' },
  { category: 'blank-spell', input: 'The opposite of happy is _', checkIndex: -1, expectedAny: ['sad', 'unhappy'], desc: 'opposite: happy' },
  { category: 'blank-spell', input: 'The opposite of light is _', checkIndex: -1, expectedAny: ['dark', 'heavy'], desc: 'opposite: light' },
  { category: 'blank-spell', input: 'The opposite of old is _', checkIndex: -1, expectedAny: ['young', 'new'], desc: 'opposite: old' },
  { category: 'blank-spell', input: 'The opposite of rich is _', checkIndex: -1, expectedAny: ['poor'], desc: 'opposite: rich' },
  { category: 'blank-spell', input: 'The opposite of love is _', checkIndex: -1, expectedAny: ['hate', 'hatred'], desc: 'opposite: love' },
  { category: 'blank-spell', input: 'The opposite of open is _', checkIndex: -1, expectedAny: ['closed', 'shut'], desc: 'opposite: open' },
  { category: 'blank-spell', input: 'The opposite of true is _', checkIndex: -1, expectedAny: ['false'], desc: 'opposite: true' },
  // Synonyms
  { category: 'blank-spell', input: 'A synonym for happy is _', checkIndex: -1, expectedAny: ['joyful', 'glad', 'cheerful', 'content', 'delighted'], desc: 'synonym: happy' },
  { category: 'blank-spell', input: 'A synonym for big is _', checkIndex: -1, expectedAny: ['large', 'huge', 'enormous', 'massive', 'great'], desc: 'synonym: big' },
  { category: 'blank-spell', input: 'A synonym for fast is _', checkIndex: -1, expectedAny: ['quick', 'rapid', 'swift', 'speedy'], desc: 'synonym: fast' },
  { category: 'blank-spell', input: 'A synonym for angry is _', checkIndex: -1, expectedAny: ['furious', 'mad', 'irate', 'enraged'], desc: 'synonym: angry' },
  { category: 'blank-spell', input: 'A synonym for beautiful is _', checkIndex: -1, expectedAny: ['gorgeous', 'stunning', 'lovely', 'pretty'], desc: 'synonym: beautiful' },
  { category: 'blank-spell', input: 'Another word for scared is _', checkIndex: -1, expectedAny: ['afraid', 'frightened', 'terrified', 'fearful'], desc: 'another: scared' },
  { category: 'blank-spell', input: 'Another word for smart is _', checkIndex: -1, expectedAny: ['intelligent', 'clever', 'bright', 'brilliant'], desc: 'another: smart' },
  { category: 'blank-spell', input: 'Means the same as tired _', checkIndex: -1, expectedAny: ['exhausted', 'fatigued', 'weary', 'drained'], desc: 'same as: tired' },
  // Antonyms
  { category: 'blank-spell', input: 'An antonym of light is _', checkIndex: -1, expectedAny: ['dark', 'heavy'], desc: 'antonym: light' },
  { category: 'blank-spell', input: 'An antonym of quiet is _', checkIndex: -1, expectedAny: ['loud', 'noisy'], desc: 'antonym: quiet' },
  // Rhymes
  { category: 'blank-spell', input: 'Rhymes with cat _', checkIndex: -1, expectedAny: ['hat', 'bat', 'mat', 'rat', 'sat', 'fat', 'flat'], desc: 'rhyme: cat' },
  { category: 'blank-spell', input: 'Rhymes with dog _', checkIndex: -1, expectedAny: ['log', 'fog', 'bog', 'hog', 'frog', 'jog'], desc: 'rhyme: dog' },
  { category: 'blank-spell', input: 'Rhymes with day _', checkIndex: -1, expectedAny: ['way', 'say', 'play', 'may', 'pay', 'stay', 'bay'], desc: 'rhyme: day' },
  { category: 'blank-spell', input: 'Rhymes with moon _', checkIndex: -1, expectedAny: ['soon', 'noon', 'spoon', 'tune', 'June', 'balloon'], desc: 'rhyme: moon' },
  { category: 'blank-spell', input: 'Rhymes with light _', checkIndex: -1, expectedAny: ['night', 'sight', 'right', 'bright', 'fight', 'might', 'white', 'flight'], desc: 'rhyme: light' },
  { category: 'blank-spell', input: 'Rhymes with tree _', checkIndex: -1, expectedAny: ['free', 'sea', 'three', 'key', 'bee', 'see', 'me', 'we'], desc: 'rhyme: tree' },
  { category: 'blank-spell', input: 'Rhymes with blue _', checkIndex: -1, expectedAny: ['true', 'new', 'two', 'you', 'shoe', 'through', 'flew', 'grew', 'clue'], desc: 'rhyme: blue' },
  { category: 'blank-spell', input: 'Rhymes with rain _', checkIndex: -1, expectedAny: ['pain', 'main', 'brain', 'train', 'gain', 'lane', 'plain', 'chain'], desc: 'rhyme: rain' },
  { category: 'blank-spell', input: 'Rhymes with book _', checkIndex: -1, expectedAny: ['look', 'cook', 'hook', 'took', 'shook', 'nook', 'brook'], desc: 'rhyme: book' },
  { category: 'blank-spell', input: 'Rhymes with ring _', checkIndex: -1, expectedAny: ['sing', 'king', 'thing', 'spring', 'bring', 'wing', 'string', 'swing'], desc: 'rhyme: ring' },
];

const BLANK_COLOR_TESTS: TestCase[] = [
  // Basic colors → hex
  { category: 'blank-color', input: 'Red in hex is _', checkIndex: -1, expectedAny: ['#FF0000', '#ff0000'], desc: 'red→hex' },
  { category: 'blank-color', input: 'Blue in hex is _', checkIndex: -1, expectedAny: ['#0000FF', '#0000ff'], desc: 'blue→hex' },
  { category: 'blank-color', input: 'Green in hex is _', checkIndex: -1, expectedAny: ['#00FF00', '#00ff00', '#008000', '#008000'], desc: 'green→hex' },
  { category: 'blank-color', input: 'White in hex is _', checkIndex: -1, expectedAny: ['#FFFFFF', '#ffffff', '#FFF'], desc: 'white→hex' },
  { category: 'blank-color', input: 'Black in hex is _', checkIndex: -1, expectedAny: ['#000000', '#000', '#000000'], desc: 'black→hex' },
  { category: 'blank-color', input: 'Yellow in hex is _', checkIndex: -1, expectedAny: ['#FFFF00', '#ffff00'], desc: 'yellow→hex' },
  { category: 'blank-color', input: 'Hex for purple is _', checkIndex: -1, expectedAny: ['#800080', '#A020F0', '#a020f0', '#8B008B'], desc: 'purple→hex' },
  { category: 'blank-color', input: 'Hex for orange is _', checkIndex: -1, expectedAny: ['#FFA500', '#ffa500', '#FF8C00'], desc: 'orange→hex' },
  { category: 'blank-color', input: 'Hex for cyan is _', checkIndex: -1, expectedAny: ['#00FFFF', '#00ffff'], desc: 'cyan→hex' },
  { category: 'blank-color', input: 'Hex for pink is _', checkIndex: -1, expectedAny: ['#FFC0CB', '#ffc0cb', '#FF69B4'], desc: 'pink→hex' },
  { category: 'blank-color', input: 'Hex for gray is _', checkIndex: -1, expectedAny: ['#808080', '#C0C0C0', '#A9A9A9', '#808080'], desc: 'gray→hex' },
  { category: 'blank-color', input: 'Hex for brown is _', checkIndex: -1, expectedAny: ['#A52A2A', '#8B4513', '#a52a2a', '#964B00'], desc: 'brown→hex' },
  { category: 'blank-color', input: 'Hex for navy is _', checkIndex: -1, expectedAny: ['#000080', '#000080'], desc: 'navy→hex' },
  { category: 'blank-color', input: 'Hex for gold is _', checkIndex: -1, expectedAny: ['#FFD700', '#ffd700'], desc: 'gold→hex' },
  { category: 'blank-color', input: 'Hex for silver is _', checkIndex: -1, expectedAny: ['#C0C0C0', '#c0c0c0'], desc: 'silver→hex' },
  // Colors → RGB
  { category: 'blank-color', input: 'Red in rgb is _', checkIndex: -1, expectedAny: ['rgb(255,0,0)', 'rgb(255, 0, 0)', '255,0,0'], desc: 'red→rgb' },
  { category: 'blank-color', input: 'Blue in rgb is _', checkIndex: -1, expectedAny: ['rgb(0,0,255)', 'rgb(0, 0, 255)', '0,0,255'], desc: 'blue→rgb' },
  { category: 'blank-color', input: 'Green in rgb is _', checkIndex: -1, expectedAny: ['rgb(0,255,0)', 'rgb(0, 255, 0)', 'rgb(0,128,0)', '0,255,0', '0,128,0'], desc: 'green→rgb' },
  { category: 'blank-color', input: 'White in rgb is _', checkIndex: -1, expectedAny: ['rgb(255,255,255)', 'rgb(255, 255, 255)', '255,255,255'], desc: 'white→rgb' },
  { category: 'blank-color', input: 'Black in rgb is _', checkIndex: -1, expectedAny: ['rgb(0,0,0)', 'rgb(0, 0, 0)', '0,0,0'], desc: 'black→rgb' },
  // CSS color names
  { category: 'blank-color', input: 'Color code for teal is _', checkIndex: -1, expectedAny: ['#008080', '#008080'], desc: 'teal→hex' },
  { category: 'blank-color', input: 'Color code for magenta is _', checkIndex: -1, expectedAny: ['#FF00FF', '#ff00ff'], desc: 'magenta→hex' },
  { category: 'blank-color', input: 'Color code for lime is _', checkIndex: -1, expectedAny: ['#00FF00', '#00ff00', '#32CD32'], desc: 'lime→hex' },
  { category: 'blank-color', input: 'Color code for coral is _', checkIndex: -1, expectedAny: ['#FF7F50', '#ff7f50'], desc: 'coral→hex' },
  { category: 'blank-color', input: 'Color code for indigo is _', checkIndex: -1, expectedAny: ['#4B0082', '#4b0082'], desc: 'indigo→hex' },
  // Hex for web colors
  { category: 'blank-color', input: 'Hex for turquoise is _', checkIndex: -1, expectedAny: ['#40E0D0', '#40e0d0', '#30D5C8'], desc: 'turquoise→hex' },
  { category: 'blank-color', input: 'Hex for maroon is _', checkIndex: -1, expectedAny: ['#800000', '#800000'], desc: 'maroon→hex' },
  { category: 'blank-color', input: 'Hex for olive is _', checkIndex: -1, expectedAny: ['#808000', '#808000'], desc: 'olive→hex' },
  { category: 'blank-color', input: 'Hex for salmon is _', checkIndex: -1, expectedAny: ['#FA8072', '#fa8072'], desc: 'salmon→hex' },
  { category: 'blank-color', input: 'Hex for violet is _', checkIndex: -1, expectedAny: ['#EE82EE', '#ee82ee', '#8B00FF', '#7F00FF'], desc: 'violet→hex' },
];

const BLANK_HTTP_TESTS: TestCase[] = [
  // Meaning → Code
  { category: 'blank-http', input: 'HTTP status for OK is _', checkIndex: -1, expectedAny: ['200'], desc: 'OK→200' },
  { category: 'blank-http', input: 'HTTP status for created is _', checkIndex: -1, expectedAny: ['201'], desc: 'created→201' },
  { category: 'blank-http', input: 'HTTP status for no content is _', checkIndex: -1, expectedAny: ['204'], desc: 'no content→204' },
  { category: 'blank-http', input: 'HTTP status for redirect is _', checkIndex: -1, expectedAny: ['301', '302', '307'], desc: 'redirect→30x' },
  { category: 'blank-http', input: 'HTTP status for not modified is _', checkIndex: -1, expectedAny: ['304'], desc: 'not modified→304' },
  { category: 'blank-http', input: 'HTTP status for bad request is _', checkIndex: -1, expectedAny: ['400'], desc: 'bad request→400' },
  { category: 'blank-http', input: 'HTTP status for unauthorized is _', checkIndex: -1, expectedAny: ['401'], desc: 'unauthorized→401' },
  { category: 'blank-http', input: 'HTTP status for forbidden is _', checkIndex: -1, expectedAny: ['403'], desc: 'forbidden→403' },
  { category: 'blank-http', input: 'HTTP status for not found is _', checkIndex: -1, expectedAny: ['404'], desc: 'not found→404' },
  { category: 'blank-http', input: 'HTTP status for method not allowed is _', checkIndex: -1, expectedAny: ['405'], desc: 'method not allowed→405' },
  { category: 'blank-http', input: 'HTTP status for conflict is _', checkIndex: -1, expectedAny: ['409'], desc: 'conflict→409' },
  { category: 'blank-http', input: 'HTTP status for gone is _', checkIndex: -1, expectedAny: ['410'], desc: 'gone→410' },
  { category: 'blank-http', input: 'HTTP status for too many requests is _', checkIndex: -1, expectedAny: ['429'], desc: 'rate limit→429' },
  { category: 'blank-http', input: 'HTTP status for server error is _', checkIndex: -1, expectedAny: ['500'], desc: 'server error→500' },
  { category: 'blank-http', input: 'HTTP status for bad gateway is _', checkIndex: -1, expectedAny: ['502'], desc: 'bad gateway→502' },
  { category: 'blank-http', input: 'HTTP status for service unavailable is _', checkIndex: -1, expectedAny: ['503'], desc: 'unavailable→503' },
  { category: 'blank-http', input: 'HTTP status for gateway timeout is _', checkIndex: -1, expectedAny: ['504'], desc: 'gateway timeout→504' },
  { category: 'blank-http', input: 'HTTP status for accepted is _', checkIndex: -1, expectedAny: ['202'], desc: 'accepted→202' },
  // Code → Meaning
  { category: 'blank-http', input: 'HTTP 200 means _', checkIndex: -1, expectedAny: ['OK', 'ok', 'Ok'], desc: '200→OK' },
  { category: 'blank-http', input: 'HTTP 404 means _', checkIndex: -1, expectedAny: ['Not Found', 'not found'], desc: '404→Not Found' },
  { category: 'blank-http', input: 'HTTP 500 means _', checkIndex: -1, expectedAny: ['Internal Server Error', 'internal server error', 'Server Error'], desc: '500→ISE' },
  { category: 'blank-http', input: 'HTTP 301 means _', checkIndex: -1, expectedAny: ['Moved Permanently', 'moved permanently'], desc: '301→Moved' },
  { category: 'blank-http', input: 'HTTP 403 means _', checkIndex: -1, expectedAny: ['Forbidden', 'forbidden'], desc: '403→Forbidden' },
  { category: 'blank-http', input: 'HTTP 401 means _', checkIndex: -1, expectedAny: ['Unauthorized', 'unauthorized'], desc: '401→Unauthorized' },
  { category: 'blank-http', input: 'HTTP 201 means _', checkIndex: -1, expectedAny: ['Created', 'created'], desc: '201→Created' },
  { category: 'blank-http', input: 'HTTP 204 means _', checkIndex: -1, expectedAny: ['No Content', 'no content'], desc: '204→No Content' },
  { category: 'blank-http', input: 'HTTP 400 means _', checkIndex: -1, expectedAny: ['Bad Request', 'bad request'], desc: '400→Bad Request' },
  { category: 'blank-http', input: 'HTTP 502 means _', checkIndex: -1, expectedAny: ['Bad Gateway', 'bad gateway'], desc: '502→Bad Gateway' },
  { category: 'blank-http', input: 'HTTP 503 means _', checkIndex: -1, expectedAny: ['Service Unavailable', 'service unavailable'], desc: '503→Unavailable' },
  { category: 'blank-http', input: 'HTTP 429 means _', checkIndex: -1, expectedAny: ['Too Many Requests', 'too many requests', 'Rate Limit'], desc: '429→Rate Limit' },
];

const BLANK_TIMEZONE_TESTS: TestCase[] = [
  // EST ↔ PST
  { category: 'blank-tz', input: '9am EST in PST is _', checkIndex: -1, expectedAny: ['6am', '6:00am', '6 am'], desc: '9am EST→PST' },
  { category: 'blank-tz', input: '3pm PST in EST is _', checkIndex: -1, expectedAny: ['6pm', '6:00pm', '6 pm'], desc: '3pm PST→EST' },
  { category: 'blank-tz', input: '10am PST in EST is _', checkIndex: -1, expectedAny: ['1pm', '1:00pm', '1 pm'], desc: '10am PST→EST' },
  { category: 'blank-tz', input: 'noon EST in PST is _', checkIndex: -1, expectedAny: ['9am', '9:00am', '9 am'], desc: 'noon EST→PST' },
  { category: 'blank-tz', input: 'midnight EST in PST is _', checkIndex: -1, expectedAny: ['9pm', '9:00pm', '9 pm'], desc: 'midnight EST→PST' },
  // UTC conversions
  { category: 'blank-tz', input: 'noon UTC in EST is _', checkIndex: -1, expectedAny: ['7am', '7:00am', '7 am'], desc: 'noon UTC→EST' },
  { category: 'blank-tz', input: '6am UTC in CET is _', checkIndex: -1, expectedAny: ['7am', '7:00am', '7 am'], desc: '6am UTC→CET' },
  { category: 'blank-tz', input: 'midnight UTC in JST is _', checkIndex: -1, expectedAny: ['9am', '9:00am', '9 am'], desc: 'midnight UTC→JST' },
  { category: 'blank-tz', input: '3pm UTC in IST is _', checkIndex: -1, expectedAny: ['8:30pm', '8:30 pm', '20:30'], desc: '3pm UTC→IST' },
  { category: 'blank-tz', input: '10am UTC in PST is _', checkIndex: -1, expectedAny: ['2am', '2:00am', '2 am'], desc: '10am UTC→PST' },
  // City-based
  { category: 'blank-tz', input: '3pm London time in Tokyo is _', checkIndex: -1, expectedAny: ['midnight', '12am', '12:00am', '12 am'], desc: '3pm London→Tokyo' },
  { category: 'blank-tz', input: '8pm Tokyo time in London is _', checkIndex: -1, expectedAny: ['11am', '11:00am', '11 am'], desc: '8pm Tokyo→London' },
  { category: 'blank-tz', input: '3pm New York time in London is _', checkIndex: -1, expectedAny: ['8pm', '8:00pm', '8 pm'], desc: '3pm NY→London' },
  { category: 'blank-tz', input: '2pm London time in New York is _', checkIndex: -1, expectedAny: ['9am', '9:00am', '9 am'], desc: '2pm London→NY' },
  { category: 'blank-tz', input: '9am New York time in Tokyo is _', checkIndex: -1, expectedAny: ['10pm', '10:00pm', '10 pm', '11pm'], desc: '9am NY→Tokyo' },
  // More UTC
  { category: 'blank-tz', input: '5pm UTC in GMT is _', checkIndex: -1, expectedAny: ['5pm', '5:00pm', '5 pm'], desc: '5pm UTC→GMT (same)' },
  { category: 'blank-tz', input: '8am EST in UTC is _', checkIndex: -1, expectedAny: ['1pm', '1:00pm', '1 pm'], desc: '8am EST→UTC' },
  { category: 'blank-tz', input: '4pm CET in UTC is _', checkIndex: -1, expectedAny: ['3pm', '3:00pm', '3 pm'], desc: '4pm CET→UTC' },
  { category: 'blank-tz', input: '1am JST in UTC is _', checkIndex: -1, expectedAny: ['4pm', '4:00pm', '4 pm'], desc: '1am JST→UTC' },
  // Asia
  { category: 'blank-tz', input: '10am IST in UTC is _', checkIndex: -1, expectedAny: ['4:30am', '4:30 am', '04:30'], desc: '10am IST→UTC' },
  { category: 'blank-tz', input: 'noon JST in EST is _', checkIndex: -1, expectedAny: ['10pm', '10:00pm', '10 pm', '11pm'], desc: 'noon JST→EST' },
  { category: 'blank-tz', input: '6pm KST in UTC is _', checkIndex: -1, expectedAny: ['9am', '9:00am', '9 am'], desc: '6pm KST→UTC' },
  // Australia
  { category: 'blank-tz', input: '8am AEST in UTC is _', checkIndex: -1, expectedAny: ['10pm', '10:00pm', '10 pm'], desc: '8am AEST→UTC' },
  { category: 'blank-tz', input: 'noon UTC in AEST is _', checkIndex: -1, expectedAny: ['10pm', '10:00pm', '10 pm'], desc: 'noon UTC→AEST' },
  // US zones
  { category: 'blank-tz', input: '9am CST in EST is _', checkIndex: -1, expectedAny: ['10am', '10:00am', '10 am'], desc: '9am CST→EST' },
  { category: 'blank-tz', input: '2pm MST in PST is _', checkIndex: -1, expectedAny: ['1pm', '1:00pm', '1 pm'], desc: '2pm MST→PST' },
  { category: 'blank-tz', input: '11am EST in CST is _', checkIndex: -1, expectedAny: ['10am', '10:00am', '10 am'], desc: '11am EST→CST' },
  { category: 'blank-tz', input: '7am PST in MST is _', checkIndex: -1, expectedAny: ['8am', '8:00am', '8 am'], desc: '7am PST→MST' },
  // Edge cases
  { category: 'blank-tz', input: '11pm EST in PST is _', checkIndex: -1, expectedAny: ['8pm', '8:00pm', '8 pm'], desc: '11pm EST→PST' },
  { category: 'blank-tz', input: '1am UTC in EST is _', checkIndex: -1, expectedAny: ['8pm', '8:00pm', '8 pm'], desc: '1am UTC→EST (prev day)' },
];

const BLANK_ROMAN_TESTS: TestCase[] = [
  // Arabic → Roman (basic)
  { category: 'blank-roman', input: '1 in roman numerals is _', checkIndex: -1, expectedAny: ['I'], desc: '1→I' },
  { category: 'blank-roman', input: '4 in roman numerals is _', checkIndex: -1, expectedAny: ['IV'], desc: '4→IV' },
  { category: 'blank-roman', input: '5 in roman numerals is _', checkIndex: -1, expectedAny: ['V'], desc: '5→V' },
  { category: 'blank-roman', input: '9 in roman numerals is _', checkIndex: -1, expectedAny: ['IX'], desc: '9→IX' },
  { category: 'blank-roman', input: '10 in roman numerals is _', checkIndex: -1, expectedAny: ['X'], desc: '10→X' },
  { category: 'blank-roman', input: '14 in roman numerals is _', checkIndex: -1, expectedAny: ['XIV'], desc: '14→XIV' },
  { category: 'blank-roman', input: '40 in roman numerals is _', checkIndex: -1, expectedAny: ['XL'], desc: '40→XL' },
  { category: 'blank-roman', input: '42 in roman numerals is _', checkIndex: -1, expectedAny: ['XLII'], desc: '42→XLII' },
  { category: 'blank-roman', input: '50 in roman numerals is _', checkIndex: -1, expectedAny: ['L'], desc: '50→L' },
  { category: 'blank-roman', input: '90 in roman numerals is _', checkIndex: -1, expectedAny: ['XC'], desc: '90→XC' },
  { category: 'blank-roman', input: '99 in roman numerals is _', checkIndex: -1, expectedAny: ['XCIX'], desc: '99→XCIX' },
  { category: 'blank-roman', input: '100 in roman numerals is _', checkIndex: -1, expectedAny: ['C'], desc: '100→C' },
  { category: 'blank-roman', input: '400 in roman numerals is _', checkIndex: -1, expectedAny: ['CD'], desc: '400→CD' },
  { category: 'blank-roman', input: '500 in roman numerals is _', checkIndex: -1, expectedAny: ['D'], desc: '500→D' },
  { category: 'blank-roman', input: '900 in roman numerals is _', checkIndex: -1, expectedAny: ['CM'], desc: '900→CM' },
  { category: 'blank-roman', input: '1000 in roman numerals is _', checkIndex: -1, expectedAny: ['M'], desc: '1000→M' },
  { category: 'blank-roman', input: '1990 in roman numerals is _', checkIndex: -1, expectedAny: ['MCMXC'], desc: '1990→MCMXC' },
  { category: 'blank-roman', input: '2024 in roman numerals is _', checkIndex: -1, expectedAny: ['MMXXIV'], desc: '2024→MMXXIV' },
  { category: 'blank-roman', input: '3999 in roman numerals is _', checkIndex: -1, expectedAny: ['MMMCMXCIX'], desc: '3999→MMMCMXCIX' },
  { category: 'blank-roman', input: '888 in roman numerals is _', checkIndex: -1, expectedAny: ['DCCCLXXXVIII'], desc: '888→DCCCLXXXVIII' },
  // Roman → Arabic
  { category: 'blank-roman', input: 'XIV in numbers is _', checkIndex: -1, expectedAny: ['14'], desc: 'XIV→14' },
  { category: 'blank-roman', input: 'XLII in numbers is _', checkIndex: -1, expectedAny: ['42'], desc: 'XLII→42' },
  { category: 'blank-roman', input: 'MCMXC in numbers is _', checkIndex: -1, expectedAny: ['1990'], desc: 'MCMXC→1990' },
  { category: 'blank-roman', input: 'MMXXIV in numbers is _', checkIndex: -1, expectedAny: ['2024'], desc: 'MMXXIV→2024' },
  { category: 'blank-roman', input: 'IX in numbers is _', checkIndex: -1, expectedAny: ['9'], desc: 'IX→9' },
  { category: 'blank-roman', input: 'CDXLIV in numbers is _', checkIndex: -1, expectedAny: ['444'], desc: 'CDXLIV→444' },
  { category: 'blank-roman', input: 'DCCCLXXXVIII in numbers is _', checkIndex: -1, expectedAny: ['888'], desc: 'DCCCLXXXVIII→888' },
  { category: 'blank-roman', input: 'MMMCMXCIX in numbers is _', checkIndex: -1, expectedAny: ['3999'], desc: 'MMMCMXCIX→3999' },
  { category: 'blank-roman', input: 'XCIX in numbers is _', checkIndex: -1, expectedAny: ['99'], desc: 'XCIX→99' },
  { category: 'blank-roman', input: 'LXXVII in numbers is _', checkIndex: -1, expectedAny: ['77'], desc: 'LXXVII→77' },
];

const ALL_TESTS = [...WORD_TESTS, ...WORD_FINANCIAL_TESTS, ...BLANK_MATH_TESTS, ...BLANK_FACTUAL_TESTS, ...BLANK_TRANSLATION_TESTS, ...BLANK_UNIT_TESTS, ...BLANK_SPELLING_TESTS, ...BLANK_COLOR_TESTS, ...BLANK_HTTP_TESTS, ...BLANK_TIMEZONE_TESTS, ...BLANK_ROMAN_TESTS, ...BLANK_GRAMMAR_TESTS];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface TestResult {
  desc: string;
  category: string;
  input: string;
  pass: boolean;
  alternatives: string[];
  expectedAny: string[];
  matched: string | null;
  latencyMs: number;
  error?: string;
}

async function runTest(tc: TestCase): Promise<TestResult> {
  const start = Date.now();
  try {
    const words = tc.input.split(/\s+/).filter(Boolean);
    const context: CueContext = { text: tc.input, words };
    const resolved = await resolver.resolve(context);
    const latencyMs = Date.now() - start;

    // Find the result to check
    let alts: string[] = [];
    if (tc.checkIndex === -1) {
      // Blank: find the _ position
      const blankIdx = words.indexOf('_');
      const r = resolved.results.find(x => x.wordIndex === blankIdx);
      alts = r ? r.alternatives.filter(a => a !== '_') : [];
    } else {
      const r = resolved.results.find(x => x.wordIndex === tc.checkIndex);
      alts = r ? r.alternatives.slice(1) : []; // skip original at [0]
    }

    const altsLower = alts.map(a => a.toLowerCase());
    const matched = tc.expectedAny.find(e => altsLower.includes(e.toLowerCase())) || null;

    return {
      desc: tc.desc,
      category: tc.category,
      input: tc.input,
      pass: matched !== null,
      alternatives: alts.slice(0, 5),
      expectedAny: tc.expectedAny,
      matched,
      latencyMs,
    };
  } catch (err: any) {
    return {
      desc: tc.desc,
      category: tc.category,
      input: tc.input,
      pass: false,
      alternatives: [],
      expectedAny: tc.expectedAny,
      matched: null,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

async function main() {
  console.log(`\nOpenCues cues-core benchmark`);
  console.log(`Model: ${MODEL}`);
  console.log(`Tests: ${ALL_TESTS.length}`);
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  const results: TestResult[] = [];
  const catStats: Record<string, { pass: number; total: number; latency: number[] }> = {};

  for (const tc of ALL_TESTS) {
    const r = await runTest(tc);
    results.push(r);

    if (!catStats[tc.category]) catStats[tc.category] = { pass: 0, total: 0, latency: [] };
    catStats[tc.category].total++;
    catStats[tc.category].latency.push(r.latencyMs);
    if (r.pass) catStats[tc.category].pass++;

    const mark = r.pass ? '✓' : '✗';
    const altsStr = r.alternatives.slice(0, 3).join(', ');
    console.log(`  ${mark} ${r.desc} (${r.latencyMs}ms) → ${altsStr || r.error || 'none'}`);
  }

  // Summary
  console.log('\n--- Summary ---');
  let totalPass = 0, totalCount = 0;
  for (const [cat, s] of Object.entries(catStats)) {
    const avg = Math.round(s.latency.reduce((a, b) => a + b, 0) / s.latency.length);
    const pct = ((s.pass / s.total) * 100).toFixed(1);
    console.log(`  ${cat}: ${s.pass}/${s.total} (${pct}%) avg ${avg}ms`);
    totalPass += s.pass;
    totalCount += s.total;
  }
  const totalPct = ((totalPass / totalCount) * 100).toFixed(1);
  console.log(`\n  TOTAL: ${totalPass}/${totalCount} (${totalPct}%)`);

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const modelSlug = MODEL.replace(/\//g, '-');
  const outDir = path.resolve(__dirname, '../results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `cuescore-${modelSlug}-${timestamp}.json`);

  const saved = {
    model: MODEL,
    timestamp: new Date().toISOString(),
    endpoint: ENDPOINT,
    totalPass,
    totalCount,
    totalPct: parseFloat(totalPct),
    categories: catStats,
    results,
  };

  fs.writeFileSync(outPath, JSON.stringify(saved, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch(console.error);
