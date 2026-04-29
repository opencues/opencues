/** Ported SPELLING benchmark cases (20). */

import { FluidBlankCase } from './cases';

export const CASES_SPELLING_BENCH: FluidBlankCase[] = [
  { id: 'sb-the-opposite-of-hot-is', category: 'inline', input: 'The opposite of hot is _', expected: { span: 'The opposite of hot is _', question: 'What is the opposite of hot?', answer: 'cold', answerAlternates: [] } },
  { id: 'sb-the-opposite-of-big-is', category: 'inline', input: 'The opposite of big is _', expected: { span: 'The opposite of big is _', question: 'What is the opposite of big?', answer: 'small', answerAlternates: ['little', 'tiny'] } },
  { id: 'sb-the-opposite-of-fast-is', category: 'inline', input: 'The opposite of fast is _', expected: { span: 'The opposite of fast is _', question: 'What is the opposite of fast?', answer: 'slow', answerAlternates: [] } },
  { id: 'sb-a-synonym-for-happy-is', category: 'inline', input: 'A synonym for happy is _', expected: { span: 'A synonym for happy is _', question: 'What is a synonym for happy?', answer: 'joyful', answerAlternates: ['glad', 'cheerful', 'content', 'pleased'] } },
  { id: 'sb-a-synonym-for-big-is', category: 'inline', input: 'A synonym for big is _', expected: { span: 'A synonym for big is _', question: 'What is a synonym for big?', answer: 'large', answerAlternates: ['huge', 'enormous'] } },
  { id: 'sb-a-synonym-for-fast-is', category: 'inline', input: 'A synonym for fast is _', expected: { span: 'A synonym for fast is _', question: 'What is a synonym for fast?', answer: 'quick', answerAlternates: ['rapid', 'speedy', 'swift'] } },
  { id: 'sb-an-antonym-of-light-is', category: 'inline', input: 'An antonym of light is _', expected: { span: 'An antonym of light is _', question: 'What is an antonym of light?', answer: 'dark', answerAlternates: ['heavy'] } },
  { id: 'sb-rhymes-with-cat', category: 'inline', input: 'Rhymes with cat _', expected: { span: 'Rhymes with cat _', question: 'What is rhymes with cat?', answer: 'hat', answerAlternates: ['bat', 'mat', 'rat', 'sat'] } },
  { id: 'sb-rhymes-with-dog', category: 'inline', input: 'Rhymes with dog _', expected: { span: 'Rhymes with dog _', question: 'What is rhymes with dog?', answer: 'log', answerAlternates: ['fog', 'frog', 'jog'] } },
  { id: 'sb-rhymes-with-bell', category: 'inline', input: 'Rhymes with bell _', expected: { span: 'Rhymes with bell _', question: 'What is rhymes with bell?', answer: 'tell', answerAlternates: ['fell', 'hell', 'sell', 'well'] } },
  { id: 'sb-another-word-for-beautiful-is', category: 'inline', input: 'Another word for beautiful is _', expected: { span: 'Another word for beautiful is _', question: 'What is another word for beautiful?', answer: 'gorgeous', answerAlternates: ['stunning', 'lovely', 'pretty'] } },
  { id: 'sb-another-word-for-smart-is', category: 'inline', input: 'Another word for smart is _', expected: { span: 'Another word for smart is _', question: 'What is another word for smart?', answer: 'intelligent', answerAlternates: ['clever', 'bright', 'wise'] } },
  { id: 'sb-means-the-same-as-angry', category: 'inline', input: 'Means the same as angry _', expected: { span: 'Means the same as angry _', question: 'What is means the same as angry?', answer: 'furious', answerAlternates: ['mad', 'irritated'] } },
  { id: 'sb-the-opposite-of-love-is', category: 'inline', input: 'The opposite of love is _', expected: { span: 'The opposite of love is _', question: 'What is the opposite of love?', answer: 'hate', answerAlternates: [] } },
  { id: 'sb-a-synonym-for-tired-is', category: 'inline', input: 'A synonym for tired is _', expected: { span: 'A synonym for tired is _', question: 'What is a synonym for tired?', answer: 'exhausted', answerAlternates: ['weary', 'fatigued', 'drained'] } },
  { id: 'sb-the-opposite-of-strong-is', category: 'inline', input: 'The opposite of strong is _', expected: { span: 'The opposite of strong is _', question: 'What is the opposite of strong?', answer: 'weak', answerAlternates: [] } },
  { id: 'sb-synonym-for-sad-is', category: 'inline', input: 'Synonym for sad is _', expected: { span: 'Synonym for sad is _', question: 'What is synonym for sad?', answer: 'unhappy', answerAlternates: ['melancholy', 'sorrowful', 'gloomy'] } },
  { id: 'sb-antonym-of-wide-is', category: 'inline', input: 'Antonym of wide is _', expected: { span: 'Antonym of wide is _', question: 'What is antonym of wide?', answer: 'narrow', answerAlternates: [] } },
  { id: 'sb-rhymes-with-sky', category: 'inline', input: 'Rhymes with sky _', expected: { span: 'Rhymes with sky _', question: 'What is rhymes with sky?', answer: 'fly', answerAlternates: ['by', 'cry', 'high', 'pie'] } },
  { id: 'sb-the-opposite-of-begin-is', category: 'inline', input: 'The opposite of begin is _', expected: { span: 'The opposite of begin is _', question: 'What is the opposite of begin?', answer: 'end', answerAlternates: ['finish'] } },
];
