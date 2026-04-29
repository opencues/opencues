/** Ported TRANSLATION benchmark cases (20). */

import { FluidBlankCase } from './cases';

export const CASES_TRANSLATION_BENCH: FluidBlankCase[] = [
  { id: 'tb-hello-in-french-is', category: 'inline', input: 'Hello in French is _', expected: { span: 'Hello in French is _', question: 'What is hello in French?', answer: 'Bonjour', answerAlternates: ['bonjour', 'salut'] } },
  { id: 'tb-thank-you-in-japanese-is', category: 'inline', input: 'Thank you in Japanese is _', expected: { span: 'Thank you in Japanese is _', question: 'What is thank you in Japanese?', answer: 'Arigatou', answerAlternates: ['arigato', 'arigatou', 'arigatou gozaimasu'] } },
  { id: 'tb-dog-in-spanish-is', category: 'inline', input: 'Dog in Spanish is _', expected: { span: 'Dog in Spanish is _', question: 'What is dog in Spanish?', answer: 'Perro', answerAlternates: ['perro'] } },
  { id: 'tb-water-in-french-is', category: 'inline', input: 'Water in French is _', expected: { span: 'Water in French is _', question: 'What is water in French?', answer: 'Eau', answerAlternates: ['l\'eau', 'eau'] } },
  { id: 'tb-house-in-german-is', category: 'inline', input: 'House in German is _', expected: { span: 'House in German is _', question: 'What is house in German?', answer: 'Haus', answerAlternates: ['das Haus', 'haus'] } },
  { id: 'tb-goodbye-in-italian-is', category: 'inline', input: 'Goodbye in Italian is _', expected: { span: 'Goodbye in Italian is _', question: 'What is goodbye in Italian?', answer: 'Arrivederci', answerAlternates: ['arrivederci', 'ciao'] } },
  { id: 'tb-cat-in-portuguese-is', category: 'inline', input: 'Cat in Portuguese is _', expected: { span: 'Cat in Portuguese is _', question: 'What is cat in Portuguese?', answer: 'Gato', answerAlternates: ['gato'] } },
  { id: 'tb-love-in-latin-is', category: 'inline', input: 'Love in Latin is _', expected: { span: 'Love in Latin is _', question: 'What is love in Latin?', answer: 'Amor', answerAlternates: ['amor'] } },
  { id: 'tb-friend-in-korean-is', category: 'inline', input: 'Friend in Korean is _', expected: { span: 'Friend in Korean is _', question: 'What is friend in Korean?', answer: 'Chingu', answerAlternates: ['chingu', '친구'] } },
  { id: 'tb-peace-in-hebrew-is', category: 'inline', input: 'Peace in Hebrew is _', expected: { span: 'Peace in Hebrew is _', question: 'What is peace in Hebrew?', answer: 'Shalom', answerAlternates: ['shalom'] } },
  { id: 'tb-bread-in-french-is', category: 'inline', input: 'Bread in French is _', expected: { span: 'Bread in French is _', question: 'What is bread in French?', answer: 'Pain', answerAlternates: ['le pain', 'pain'] } },
  { id: 'tb-book-in-german-is', category: 'inline', input: 'Book in German is _', expected: { span: 'Book in German is _', question: 'What is book in German?', answer: 'Buch', answerAlternates: ['das Buch', 'buch'] } },
  { id: 'tb-red-in-spanish-is', category: 'inline', input: 'Red in Spanish is _', expected: { span: 'Red in Spanish is _', question: 'What is red in Spanish?', answer: 'Rojo', answerAlternates: ['rojo'] } },
  { id: 'tb-yes-in-russian-is', category: 'inline', input: 'Yes in Russian is _', expected: { span: 'Yes in Russian is _', question: 'What is yes in Russian?', answer: 'Da', answerAlternates: ['da', 'да'] } },
  { id: 'tb-mother-in-italian-is', category: 'inline', input: 'Mother in Italian is _', expected: { span: 'Mother in Italian is _', question: 'What is mother in Italian?', answer: 'Madre', answerAlternates: ['madre', 'mamma'] } },
  { id: 'tb-cheese-in-french-is', category: 'inline', input: 'Cheese in French is _', expected: { span: 'Cheese in French is _', question: 'What is cheese in French?', answer: 'Fromage', answerAlternates: ['fromage'] } },
  { id: 'tb-sun-in-spanish-is', category: 'inline', input: 'Sun in Spanish is _', expected: { span: 'Sun in Spanish is _', question: 'What is sun in Spanish?', answer: 'Sol', answerAlternates: ['sol', 'el sol'] } },
  { id: 'tb-sea-in-italian-is', category: 'inline', input: 'Sea in Italian is _', expected: { span: 'Sea in Italian is _', question: 'What is sea in Italian?', answer: 'Mare', answerAlternates: ['mare', 'il mare'] } },
  { id: 'tb-fire-in-german-is', category: 'inline', input: 'Fire in German is _', expected: { span: 'Fire in German is _', question: 'What is fire in German?', answer: 'Feuer', answerAlternates: ['feuer', 'das Feuer'] } },
  { id: 'tb-yellow-in-japanese-is', category: 'inline', input: 'Yellow in Japanese is _', expected: { span: 'Yellow in Japanese is _', question: 'What is yellow in Japanese?', answer: 'Kiiro', answerAlternates: ['kiiro', 'ki-iro', '黄色'] } },
];
