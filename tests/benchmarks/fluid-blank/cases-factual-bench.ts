/**
 * Ported FACTUAL benchmark cases.
 *
 * All 102 cases from tests/benchmarks/factual.sh (51) and
 * tests/benchmarks/factual-edge.sh (51), reformatted as FluidBlankCase
 * so they can run through the fluid-blank P1+P3 pipeline.
 *
 * These are the cases the existing FACTUAL mode handles in production.
 * If fluid-blank's pass rate on this suite ≥ FACTUAL's, the upgrade is
 * safe to ship.
 *
 * Run: npx tsx tests/benchmarks/fluid-blank/run.ts --factual-bench --mode answer
 *
 * NOTE: ~14 cases have `_` in the MIDDLE (synthetic shape), e.g.
 * "Water boils at _ degrees Celsius". Real factual.sh inputs include
 * these; fluid-blank's P1 handles synthetic shape at ~95% so they
 * should mostly work, but expect some segmentation challenges.
 */

import { FluidBlankCase } from './cases';

export const CASES_FACTUAL_BENCH: FluidBlankCase[] = [
  // ─── CEOs ────────────────────────────────────────────────────────────
  { id: 'fb-apple-ceo',     category: 'inline', input: 'The CEO of Apple is _',     expected: { span: 'The CEO of Apple is _',     question: 'Who is the CEO of Apple?',     answer: 'Tim Cook',        answerAlternates: ['Cook', 'Timothy Cook'] } },
  { id: 'fb-microsoft-ceo', category: 'inline', input: 'The CEO of Microsoft is _', expected: { span: 'The CEO of Microsoft is _', question: 'Who is the CEO of Microsoft?', answer: 'Satya Nadella',   answerAlternates: ['Nadella'] } },
  { id: 'fb-tesla-ceo',     category: 'inline', input: 'The CEO of Tesla is _',     expected: { span: 'The CEO of Tesla is _',     question: 'Who is the CEO of Tesla?',     answer: 'Elon Musk',       answerAlternates: ['Musk'] } },
  { id: 'fb-amazon-ceo',    category: 'inline', input: 'The CEO of Amazon is _',    expected: { span: 'The CEO of Amazon is _',    question: 'Who is the CEO of Amazon?',    answer: 'Andy Jassy',      answerAlternates: ['Jassy'] } },
  { id: 'fb-google-ceo',    category: 'inline', input: 'The CEO of Google is _',    expected: { span: 'The CEO of Google is _',    question: 'Who is the CEO of Google?',    answer: 'Sundar Pichai',   answerAlternates: ['Pichai'] } },
  { id: 'fb-meta-ceo',      category: 'inline', input: 'The CEO of Meta is _',      expected: { span: 'The CEO of Meta is _',      question: 'Who is the CEO of Meta?',      answer: 'Mark Zuckerberg', answerAlternates: ['Zuckerberg'] } },
  { id: 'fb-netflix-ceo',   category: 'inline', input: 'The CEO of Netflix is _',   expected: { span: 'The CEO of Netflix is _',   question: 'Who is the CEO of Netflix?',   answer: 'Ted Sarandos',    answerAlternates: ['Sarandos'] } },
  { id: 'fb-nvidia-ceo',    category: 'inline', input: 'The CEO of Nvidia is _',    expected: { span: 'The CEO of Nvidia is _',    question: 'Who is the CEO of Nvidia?',    answer: 'Jensen Huang',    answerAlternates: ['Huang'] } },

  // ─── Founders ────────────────────────────────────────────────────────
  { id: 'fb-amazon-founder',    category: 'inline', input: 'The founder of Amazon is _',    expected: { span: 'The founder of Amazon is _',    question: 'Who founded Amazon?',    answer: 'Jeff Bezos',       answerAlternates: ['Bezos'] } },
  { id: 'fb-facebook-founder',  category: 'inline', input: 'The founder of Facebook is _',  expected: { span: 'The founder of Facebook is _',  question: 'Who founded Facebook?',  answer: 'Mark Zuckerberg',  answerAlternates: ['Zuckerberg', 'Zuck'] } },
  { id: 'fb-microsoft-founder', category: 'inline', input: 'The founder of Microsoft is _', expected: { span: 'The founder of Microsoft is _', question: 'Who founded Microsoft?', answer: 'Bill Gates',       answerAlternates: ['Gates', 'William Gates', 'Bill Gates and Paul Allen'] } },
  { id: 'fb-apple-founder',     category: 'inline', input: 'The founder of Apple is _',     expected: { span: 'The founder of Apple is _',     question: 'Who founded Apple?',     answer: 'Steve Jobs',       answerAlternates: ['Jobs', 'Jobs and Wozniak'] } },
  { id: 'fb-spacex-founder',    category: 'inline', input: 'The founder of SpaceX is _',    expected: { span: 'The founder of SpaceX is _',    question: 'Who founded SpaceX?',    answer: 'Elon Musk',        answerAlternates: ['Musk'] } },

  // ─── Capitals (basic) ────────────────────────────────────────────────
  { id: 'fb-france-cap',     category: 'inline', input: 'The capital of France is _',     expected: { span: 'The capital of France is _',     question: 'What is the capital of France?',     answer: 'Paris',     answerAlternates: [] } },
  { id: 'fb-japan-cap',      category: 'inline', input: 'The capital of Japan is _',      expected: { span: 'The capital of Japan is _',      question: 'What is the capital of Japan?',      answer: 'Tokyo',     answerAlternates: [] } },
  { id: 'fb-australia-cap',  category: 'inline', input: 'The capital of Australia is _',  expected: { span: 'The capital of Australia is _',  question: 'What is the capital of Australia?',  answer: 'Canberra',  answerAlternates: [] } },
  { id: 'fb-brazil-cap',     category: 'inline', input: 'The capital of Brazil is _',     expected: { span: 'The capital of Brazil is _',     question: 'What is the capital of Brazil?',     answer: 'Brasilia',  answerAlternates: ['Brasília'] } },
  { id: 'fb-canada-cap',     category: 'inline', input: 'The capital of Canada is _',     expected: { span: 'The capital of Canada is _',     question: 'What is the capital of Canada?',     answer: 'Ottawa',    answerAlternates: [] } },
  { id: 'fb-germany-cap',    category: 'inline', input: 'The capital of Germany is _',    expected: { span: 'The capital of Germany is _',    question: 'What is the capital of Germany?',    answer: 'Berlin',    answerAlternates: [] } },
  { id: 'fb-italy-cap',      category: 'inline', input: 'The capital of Italy is _',      expected: { span: 'The capital of Italy is _',      question: 'What is the capital of Italy?',      answer: 'Rome',      answerAlternates: [] } },
  { id: 'fb-spain-cap',      category: 'inline', input: 'The capital of Spain is _',      expected: { span: 'The capital of Spain is _',      question: 'What is the capital of Spain?',      answer: 'Madrid',    answerAlternates: [] } },
  { id: 'fb-china-cap',      category: 'inline', input: 'The capital of China is _',      expected: { span: 'The capital of China is _',      question: 'What is the capital of China?',      answer: 'Beijing',   answerAlternates: ['Peking'] } },
  { id: 'fb-india-cap',      category: 'inline', input: 'The capital of India is _',      expected: { span: 'The capital of India is _',      question: 'What is the capital of India?',      answer: 'New Delhi', answerAlternates: ['Delhi'] } },

  // ─── Chemical symbols ────────────────────────────────────────────────
  { id: 'fb-gold-sym',       category: 'inline', input: 'The chemical symbol for gold is _',       expected: { span: 'The chemical symbol for gold is _',       question: 'What is the chemical symbol for gold?',       answer: 'Au', answerAlternates: [] } },
  { id: 'fb-silver-sym',     category: 'inline', input: 'The chemical symbol for silver is _',     expected: { span: 'The chemical symbol for silver is _',     question: 'What is the chemical symbol for silver?',     answer: 'Ag', answerAlternates: [] } },
  { id: 'fb-iron-sym',       category: 'inline', input: 'The chemical symbol for iron is _',       expected: { span: 'The chemical symbol for iron is _',       question: 'What is the chemical symbol for iron?',       answer: 'Fe', answerAlternates: [] } },
  { id: 'fb-copper-sym',     category: 'inline', input: 'The chemical symbol for copper is _',     expected: { span: 'The chemical symbol for copper is _',     question: 'What is the chemical symbol for copper?',     answer: 'Cu', answerAlternates: [] } },
  { id: 'fb-sodium-sym',     category: 'inline', input: 'The chemical symbol for sodium is _',     expected: { span: 'The chemical symbol for sodium is _',     question: 'What is the chemical symbol for sodium?',     answer: 'Na', answerAlternates: [] } },
  { id: 'fb-potassium-sym',  category: 'inline', input: 'The chemical symbol for potassium is _',  expected: { span: 'The chemical symbol for potassium is _',  question: 'What is the chemical symbol for potassium?',  answer: 'K',  answerAlternates: [] } },

  // ─── Historical years ────────────────────────────────────────────────
  { id: 'fb-wwii-end',      category: 'inline', input: 'World War II ended in _',                        expected: { span: 'World War II ended in _',                        question: 'When did World War II end?',                  answer: '1945', answerAlternates: [] } },
  { id: 'fb-berlin-wall',   category: 'inline', input: 'The Berlin Wall fell in _',                      expected: { span: 'The Berlin Wall fell in _',                      question: 'When did the Berlin Wall fall?',              answer: '1989', answerAlternates: [] } },
  { id: 'fb-moon-landing',  category: 'inline', input: 'Man first walked on the moon in _',              expected: { span: 'Man first walked on the moon in _',              question: 'When did man first walk on the moon?',        answer: '1969', answerAlternates: [] } },
  { id: 'fb-titanic',       category: 'inline', input: 'The Titanic sank in _',                          expected: { span: 'The Titanic sank in _',                          question: 'When did the Titanic sink?',                  answer: '1912', answerAlternates: [] } },
  { id: 'fb-wwi-start',     category: 'inline', input: 'World War I started in _',                       expected: { span: 'World War I started in _',                       question: 'When did World War I start?',                 answer: '1914', answerAlternates: [] } },
  { id: 'fb-us-indep',      category: 'inline', input: 'The Declaration of Independence was signed in _',expected: { span: 'The Declaration of Independence was signed in _',question: 'When was the US Declaration of Independence signed?', answer: '1776', answerAlternates: [] } },
  { id: 'fb-french-rev',    category: 'inline', input: 'The French Revolution began in _',               expected: { span: 'The French Revolution began in _',               question: 'When did the French Revolution begin?',       answer: '1789', answerAlternates: [] } },

  // ─── Physical constants ──────────────────────────────────────────────
  { id: 'fb-water-boil',    category: 'inline', input: 'Water boils at _ degrees Celsius',     expected: { span: 'Water boils at _ degrees Celsius',     question: 'At what temperature does water boil in Celsius?',  answer: '100', answerAlternates: [] } },
  { id: 'fb-water-freeze',  category: 'inline', input: 'Water freezes at _ degrees Celsius',   expected: { span: 'Water freezes at _ degrees Celsius',   question: 'At what temperature does water freeze in Celsius?',answer: '0',   answerAlternates: [] } },
  { id: 'fb-light-speed',   category: 'inline', input: 'The speed of light is _ km/s',         expected: { span: 'The speed of light is _ km/s',         question: 'What is the speed of light in km/s?',              answer: '299792',  answerAlternates: ['300,000', '~300,000', '299792.458'] } },
  { id: 'fb-absolute-zero', category: 'inline', input: 'Absolute zero is _ Kelvin',            expected: { span: 'Absolute zero is _ Kelvin',            question: 'What is absolute zero in Kelvin?',                 answer: '0',   answerAlternates: [] } },

  // ─── Authors / artists ───────────────────────────────────────────────
  { id: 'fb-1984-author',     category: 'inline', input: 'The author of 1984 is _',                  expected: { span: 'The author of 1984 is _',                  question: 'Who wrote 1984?',                          answer: 'George Orwell',         answerAlternates: ['Orwell'] } },
  { id: 'fb-romeo-author',    category: 'inline', input: 'The author of Romeo and Juliet is _',      expected: { span: 'The author of Romeo and Juliet is _',      question: 'Who wrote Romeo and Juliet?',              answer: 'Shakespeare',           answerAlternates: ['William Shakespeare'] } },
  { id: 'fb-pride-author',    category: 'inline', input: 'The author of Pride and Prejudice is _',   expected: { span: 'The author of Pride and Prejudice is _',   question: 'Who wrote Pride and Prejudice?',           answer: 'Jane Austen',           answerAlternates: ['Austen'] } },
  { id: 'fb-gatsby-author',   category: 'inline', input: 'The author of The Great Gatsby is _',      expected: { span: 'The author of The Great Gatsby is _',      question: 'Who wrote The Great Gatsby?',              answer: 'F. Scott Fitzgerald',   answerAlternates: ['Fitzgerald', 'Scott Fitzgerald'] } },
  { id: 'fb-mona-lisa',       category: 'inline', input: 'The Mona Lisa was painted by _',           expected: { span: 'The Mona Lisa was painted by _',           question: 'Who painted the Mona Lisa?',               answer: 'Leonardo da Vinci',     answerAlternates: ['Leonardo', 'da Vinci'] } },
  { id: 'fb-starry-night',    category: 'inline', input: 'The Starry Night was painted by _',        expected: { span: 'The Starry Night was painted by _',        question: 'Who painted The Starry Night?',            answer: 'Van Gogh',              answerAlternates: ['Vincent van Gogh', 'van Gogh'] } },
  { id: 'fb-the-scream',      category: 'inline', input: 'The Scream was painted by _',              expected: { span: 'The Scream was painted by _',              question: 'Who painted The Scream?',                  answer: 'Edvard Munch',          answerAlternates: ['Munch'] } },

  // ─── Geography (basic) ───────────────────────────────────────────────
  { id: 'fb-largest-ocean',   category: 'inline', input: 'The largest ocean is the _',         expected: { span: 'The largest ocean is the _',         question: 'What is the largest ocean?',         answer: 'Pacific', answerAlternates: ['Pacific Ocean'] } },
  { id: 'fb-longest-river',   category: 'inline', input: 'The longest river is the _',         expected: { span: 'The longest river is the _',         question: 'What is the longest river?',         answer: 'Nile',    answerAlternates: ['Nile River', 'Amazon'] } },
  { id: 'fb-tallest-mountain',category: 'inline', input: 'The tallest mountain is _',          expected: { span: 'The tallest mountain is _',          question: 'What is the tallest mountain?',      answer: 'Everest', answerAlternates: ['Mount Everest', 'Mt. Everest'] } },
  { id: 'fb-largest-desert',  category: 'inline', input: 'The largest desert is the _',        expected: { span: 'The largest desert is the _',        question: 'What is the largest desert?',        answer: 'Sahara',  answerAlternates: ['Sahara Desert', 'Antarctic', 'Antarctic Desert'] } },

  // ─── Edge: capitals (obscure) ─────────────────────────────────────────
  { id: 'fb-myanmar-cap',      category: 'inline', input: 'The capital of Myanmar is _',      expected: { span: 'The capital of Myanmar is _',      question: 'What is the capital of Myanmar?',      answer: 'Naypyidaw',                 answerAlternates: ['Nay Pyi Taw'] } },
  { id: 'fb-kazakhstan-cap',   category: 'inline', input: 'The capital of Kazakhstan is _',   expected: { span: 'The capital of Kazakhstan is _',   question: 'What is the capital of Kazakhstan?',   answer: 'Astana',                    answerAlternates: ['Nur-Sultan'] } },
  { id: 'fb-srilanka-cap',     category: 'inline', input: 'The capital of Sri Lanka is _',    expected: { span: 'The capital of Sri Lanka is _',    question: 'What is the capital of Sri Lanka?',    answer: 'Sri Jayawardenepura Kotte', answerAlternates: ['Kotte', 'Colombo'] } },
  { id: 'fb-nigeria-cap',      category: 'inline', input: 'The capital of Nigeria is _',      expected: { span: 'The capital of Nigeria is _',      question: 'What is the capital of Nigeria?',      answer: 'Abuja',                     answerAlternates: [] } },
  { id: 'fb-turkey-cap',       category: 'inline', input: 'The capital of Turkey is _',       expected: { span: 'The capital of Turkey is _',       question: 'What is the capital of Turkey?',       answer: 'Ankara',                    answerAlternates: [] } },
  { id: 'fb-southafrica-cap',  category: 'inline', input: 'The capital of South Africa is _', expected: { span: 'The capital of South Africa is _', question: 'What is the capital of South Africa?', answer: 'Pretoria',                  answerAlternates: ['Cape Town', 'Bloemfontein'] } },
  { id: 'fb-pakistan-cap',     category: 'inline', input: 'The capital of Pakistan is _',     expected: { span: 'The capital of Pakistan is _',     question: 'What is the capital of Pakistan?',     answer: 'Islamabad',                 answerAlternates: [] } },
  { id: 'fb-morocco-cap',      category: 'inline', input: 'The capital of Morocco is _',      expected: { span: 'The capital of Morocco is _',      question: 'What is the capital of Morocco?',      answer: 'Rabat',                     answerAlternates: [] } },

  // ─── Mathematical constants ──────────────────────────────────────────
  { id: 'fb-pi-value',     category: 'inline', input: 'Pi equals approximately _',                 expected: { span: 'Pi equals approximately _',                 question: 'What does pi equal approximately?',           answer: '3.14159', answerAlternates: ['3.14', '3.1416'] } },
  { id: 'fb-eulers-num',   category: 'inline', input: "Euler's number e is approximately _",       expected: { span: "Euler's number e is approximately _",       question: "What is Euler's number e approximately?",     answer: '2.718',   answerAlternates: ['2.71828'] } },
  { id: 'fb-avogadro',     category: 'inline', input: "Avogadro's number is _ x 10^23",            expected: { span: "Avogadro's number is _ x 10^23",            question: "What is Avogadro's number coefficient?",      answer: '6.022',   answerAlternates: ['6.0221'] } },
  { id: 'fb-golden-ratio', category: 'inline', input: 'The golden ratio is approximately _',       expected: { span: 'The golden ratio is approximately _',       question: 'What is the golden ratio approximately?',     answer: '1.618',   answerAlternates: ['1.6180', 'phi'] } },

  // ─── Atomic numbers ──────────────────────────────────────────────────
  { id: 'fb-h-atomic',  category: 'inline', input: 'The atomic number of hydrogen is _', expected: { span: 'The atomic number of hydrogen is _', question: 'What is the atomic number of hydrogen?', answer: '1', answerAlternates: [] } },
  { id: 'fb-c-atomic',  category: 'inline', input: 'The atomic number of carbon is _',   expected: { span: 'The atomic number of carbon is _',   question: 'What is the atomic number of carbon?',   answer: '6', answerAlternates: [] } },
  { id: 'fb-o-atomic',  category: 'inline', input: 'The atomic number of oxygen is _',   expected: { span: 'The atomic number of oxygen is _',   question: 'What is the atomic number of oxygen?',   answer: '8', answerAlternates: [] } },
  { id: 'fb-n-atomic',  category: 'inline', input: 'The atomic number of nitrogen is _', expected: { span: 'The atomic number of nitrogen is _', question: 'What is the atomic number of nitrogen?', answer: '7', answerAlternates: [] } },
  { id: 'fb-he-atomic', category: 'inline', input: 'The atomic number of helium is _',   expected: { span: 'The atomic number of helium is _',   question: 'What is the atomic number of helium?',   answer: '2', answerAlternates: [] } },

  // ─── Modern tech ─────────────────────────────────────────────────────
  { id: 'fb-chatgpt',     category: 'inline', input: 'ChatGPT was created by _',           expected: { span: 'ChatGPT was created by _',           question: 'Who created ChatGPT?',           answer: 'OpenAI',           answerAlternates: [] } },
  { id: 'fb-iphone-year', category: 'inline', input: 'The iPhone was first released in _', expected: { span: 'The iPhone was first released in _', question: 'When was the iPhone first released?', answer: '2007', answerAlternates: [] } },
  { id: 'fb-www-inv',     category: 'inline', input: 'The World Wide Web was invented by _', expected: { span: 'The World Wide Web was invented by _', question: 'Who invented the World Wide Web?', answer: 'Tim Berners-Lee', answerAlternates: ['Berners-Lee'] } },
  { id: 'fb-linux-creator',  category: 'inline', input: 'Linux was created by _',          expected: { span: 'Linux was created by _',           question: 'Who created Linux?',           answer: 'Linus Torvalds',  answerAlternates: ['Torvalds'] } },
  { id: 'fb-python-creator', category: 'inline', input: 'Python was created by _',         expected: { span: 'Python was created by _',          question: 'Who created Python?',          answer: 'Guido van Rossum', answerAlternates: ['van Rossum', 'Guido'] } },

  // ─── Solar system ────────────────────────────────────────────────────
  { id: 'fb-largest-planet', category: 'inline', input: 'The largest planet is _',                            expected: { span: 'The largest planet is _',                            question: 'What is the largest planet?',                       answer: 'Jupiter', answerAlternates: [] } },
  { id: 'fb-smallest-planet',category: 'inline', input: 'The smallest planet is _',                           expected: { span: 'The smallest planet is _',                           question: 'What is the smallest planet?',                      answer: 'Mercury', answerAlternates: [] } },
  { id: 'fb-closest-planet', category: 'inline', input: 'The closest planet to the Sun is _',                 expected: { span: 'The closest planet to the Sun is _',                 question: 'What is the closest planet to the Sun?',            answer: 'Mercury', answerAlternates: [] } },
  { id: 'fb-red-planet',     category: 'inline', input: 'The red planet is _',                                expected: { span: 'The red planet is _',                                question: 'What is the red planet?',                           answer: 'Mars',    answerAlternates: [] } },
  { id: 'fb-planet-count',   category: 'inline', input: 'The number of planets in our solar system is _',     expected: { span: 'The number of planets in our solar system is _',     question: 'How many planets are in our solar system?',         answer: '8',       answerAlternates: ['eight'] } },

  // ─── Human anatomy ───────────────────────────────────────────────────
  { id: 'fb-human-bones',     category: 'inline', input: 'The human body has _ bones',                       expected: { span: 'The human body has _ bones',                       question: 'How many bones are in the human body?',     answer: '206',  answerAlternates: [] } },
  { id: 'fb-largest-organ',   category: 'inline', input: 'The largest organ is the _',                       expected: { span: 'The largest organ is the _',                       question: 'What is the largest organ in the body?',    answer: 'skin', answerAlternates: [] } },
  { id: 'fb-heart-chambers',  category: 'inline', input: 'The human heart has _ chambers',                   expected: { span: 'The human heart has _ chambers',                   question: 'How many chambers does the human heart have?', answer: '4', answerAlternates: ['four'] } },
  { id: 'fb-body-temp-f',     category: 'inline', input: 'Normal body temperature is _ degrees Fahrenheit',  expected: { span: 'Normal body temperature is _ degrees Fahrenheit',  question: 'What is normal body temperature in Fahrenheit?', answer: '98.6', answerAlternates: ['98.6°F', '~98.6'] } },
  { id: 'fb-body-temp-c',     category: 'inline', input: 'Normal body temperature is _ degrees Celsius',     expected: { span: 'Normal body temperature is _ degrees Celsius',     question: 'What is normal body temperature in Celsius?',    answer: '37',   answerAlternates: ['37°C'] } },

  // ─── Quantities ──────────────────────────────────────────────────────
  { id: 'fb-continents',  category: 'inline', input: 'There are _ continents',           expected: { span: 'There are _ continents',           question: 'How many continents are there?',           answer: '7',    answerAlternates: ['seven'] } },
  { id: 'fb-days-year',   category: 'inline', input: 'A year has _ days',                expected: { span: 'A year has _ days',                question: 'How many days are in a year?',             answer: '365',  answerAlternates: ['365.25'] } },
  { id: 'fb-decade-yrs',  category: 'inline', input: 'A decade has _ years',             expected: { span: 'A decade has _ years',             question: 'How many years are in a decade?',          answer: '10',   answerAlternates: ['ten'] } },
  { id: 'fb-century-yrs', category: 'inline', input: 'A century has _ years',            expected: { span: 'A century has _ years',            question: 'How many years are in a century?',         answer: '100',  answerAlternates: [] } },
  { id: 'fb-millen-yrs',  category: 'inline', input: 'A millennium has _ years',         expected: { span: 'A millennium has _ years',         question: 'How many years are in a millennium?',      answer: '1000', answerAlternates: ['1,000'] } },

  // ─── US Presidents ───────────────────────────────────────────────────
  { id: 'fb-first-pres',     category: 'inline', input: 'The first President of the USA was _',  expected: { span: 'The first President of the USA was _',  question: 'Who was the first US President?',          answer: 'George Washington',    answerAlternates: ['Washington'] } },
  { id: 'fb-lincoln-num',    category: 'inline', input: 'Abraham Lincoln was the _ president',   expected: { span: 'Abraham Lincoln was the _ president',   question: 'What number president was Abraham Lincoln?', answer: '16th',                 answerAlternates: ['16'] } },
  { id: 'fb-fdr',            category: 'inline', input: 'The president during WWII was _',       expected: { span: 'The president during WWII was _',       question: 'Who was US president during WWII?',        answer: 'Franklin Roosevelt',   answerAlternates: ['FDR', 'Roosevelt', 'Franklin D. Roosevelt'] } },

  // ─── Inventors ───────────────────────────────────────────────────────
  { id: 'fb-telephone-inv', category: 'inline', input: 'The inventor of the telephone is _',      expected: { span: 'The inventor of the telephone is _',      question: 'Who invented the telephone?',      answer: 'Alexander Graham Bell', answerAlternates: ['Bell', 'Graham Bell'] } },
  { id: 'fb-bulb-inv',      category: 'inline', input: 'The inventor of the light bulb is _',     expected: { span: 'The inventor of the light bulb is _',     question: 'Who invented the light bulb?',     answer: 'Thomas Edison',         answerAlternates: ['Edison'] } },
  { id: 'fb-airplane-inv',  category: 'inline', input: 'The inventor of the airplane is _',       expected: { span: 'The inventor of the airplane is _',       question: 'Who invented the airplane?',       answer: 'Wright Brothers',       answerAlternates: ['Orville Wright', 'Wilbur Wright', 'the Wright brothers'] } },
  { id: 'fb-press-inv',     category: 'inline', input: 'The inventor of the printing press is _', expected: { span: 'The inventor of the printing press is _', question: 'Who invented the printing press?', answer: 'Gutenberg',             answerAlternates: ['Johannes Gutenberg'] } },

  // ─── Composers ───────────────────────────────────────────────────────
  { id: 'fb-fur-elise',     category: 'inline', input: 'The composer of Fur Elise is _',         expected: { span: 'The composer of Fur Elise is _',         question: 'Who composed Für Elise?',           answer: 'Beethoven',  answerAlternates: ['Ludwig van Beethoven'] } },
  { id: 'fb-four-seasons',  category: 'inline', input: 'The composer of The Four Seasons is _',  expected: { span: 'The composer of The Four Seasons is _',  question: 'Who composed The Four Seasons?',    answer: 'Vivaldi',    answerAlternates: ['Antonio Vivaldi'] } },
  { id: 'fb-nutcracker',    category: 'inline', input: 'The composer of The Nutcracker is _',    expected: { span: 'The composer of The Nutcracker is _',    question: 'Who composed The Nutcracker?',      answer: 'Tchaikovsky', answerAlternates: ['Pyotr Tchaikovsky'] } },

  // ─── Acronyms / orgs ─────────────────────────────────────────────────
  { id: 'fb-nasa',  category: 'inline', input: 'NASA stands for National _ and Space Administration', expected: { span: 'NASA stands for National _ and Space Administration', question: 'What does the A in NASA stand for?',   answer: 'Aeronautics',  answerAlternates: [] } },
  { id: 'fb-un-hq', category: 'inline', input: 'The UN headquarters is in _',                         expected: { span: 'The UN headquarters is in _',                         question: 'Where are the UN headquarters?',       answer: 'New York',     answerAlternates: ['New York City', 'NYC'] } },
  { id: 'fb-fbi',   category: 'inline', input: 'FBI stands for Federal Bureau of _',                  expected: { span: 'FBI stands for Federal Bureau of _',                  question: 'What does the I in FBI stand for?',    answer: 'Investigation', answerAlternates: [] } },
  { id: 'fb-cia',   category: 'inline', input: 'CIA stands for Central _ Agency',                     expected: { span: 'CIA stands for Central _ Agency',                     question: 'What does the I in CIA stand for?',    answer: 'Intelligence',  answerAlternates: [] } },
];
