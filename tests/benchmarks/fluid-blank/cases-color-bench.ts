/** Ported COLOR benchmark cases (17). */

import { FluidBlankCase } from './cases';

export const CASES_COLOR_BENCH: FluidBlankCase[] = [
  { id: 'cb-red-in-hex-is', category: 'inline', input: 'Red in hex is _', expected: { span: 'Red in hex is _', question: 'What is red in hex?', answer: '#FF0000', answerAlternates: ['#ff0000', '#f00', 'FF0000'] } },
  { id: 'cb-blue-in-hex-is', category: 'inline', input: 'Blue in hex is _', expected: { span: 'Blue in hex is _', question: 'What is blue in hex?', answer: '#0000FF', answerAlternates: ['#0000ff', '#00f', '0000FF'] } },
  { id: 'cb-green-in-hex-is', category: 'inline', input: 'Green in hex is _', expected: { span: 'Green in hex is _', question: 'What is green in hex?', answer: '#00FF00', answerAlternates: ['#00ff00', '#0f0', '00FF00'] } },
  { id: 'cb-white-in-hex-is', category: 'inline', input: 'White in hex is _', expected: { span: 'White in hex is _', question: 'What is white in hex?', answer: '#FFFFFF', answerAlternates: ['#ffffff', '#fff'] } },
  { id: 'cb-black-in-hex-is', category: 'inline', input: 'Black in hex is _', expected: { span: 'Black in hex is _', question: 'What is black in hex?', answer: '#000000', answerAlternates: ['#000000', '#000'] } },
  { id: 'cb-yellow-in-hex-is', category: 'inline', input: 'Yellow in hex is _', expected: { span: 'Yellow in hex is _', question: 'What is yellow in hex?', answer: '#FFFF00', answerAlternates: ['#ffff00', '#ff0'] } },
  { id: 'cb-cyan-in-hex-is', category: 'inline', input: 'Cyan in hex is _', expected: { span: 'Cyan in hex is _', question: 'What is cyan in hex?', answer: '#00FFFF', answerAlternates: ['#00ffff', '#0ff'] } },
  { id: 'cb-magenta-in-hex-is', category: 'inline', input: 'Magenta in hex is _', expected: { span: 'Magenta in hex is _', question: 'What is magenta in hex?', answer: '#FF00FF', answerAlternates: ['#ff00ff', '#f0f'] } },
  { id: 'cb-hex-for-orange-is', category: 'inline', input: 'Hex for orange is _', expected: { span: 'Hex for orange is _', question: 'What is hex for orange?', answer: '#FFA500', answerAlternates: ['#ffa500'] } },
  { id: 'cb-hex-for-purple-is', category: 'inline', input: 'Hex for purple is _', expected: { span: 'Hex for purple is _', question: 'What is hex for purple?', answer: '#800080', answerAlternates: ['#800080'] } },
  { id: 'cb-hex-for-pink-is', category: 'inline', input: 'Hex for pink is _', expected: { span: 'Hex for pink is _', question: 'What is hex for pink?', answer: '#FFC0CB', answerAlternates: ['#ffc0cb'] } },
  { id: 'cb-hex-for-brown-is', category: 'inline', input: 'Hex for brown is _', expected: { span: 'Hex for brown is _', question: 'What is hex for brown?', answer: '#A52A2A', answerAlternates: ['#a52a2a'] } },
  { id: 'cb-hex-for-navy-is', category: 'inline', input: 'Hex for navy is _', expected: { span: 'Hex for navy is _', question: 'What is hex for navy?', answer: '#000080', answerAlternates: ['#000080'] } },
  { id: 'cb-red-in-rgb-is', category: 'inline', input: 'Red in rgb is _', expected: { span: 'Red in rgb is _', question: 'What is red in rgb?', answer: 'rgb(255,0,0)', answerAlternates: ['rgb(255, 0, 0)', '255,0,0', '255 0 0'] } },
  { id: 'cb-blue-in-rgb-is', category: 'inline', input: 'Blue in rgb is _', expected: { span: 'Blue in rgb is _', question: 'What is blue in rgb?', answer: 'rgb(0,0,255)', answerAlternates: ['rgb(0, 0, 255)', '0,0,255', '0 0 255'] } },
  { id: 'cb-hex-for-gold-is', category: 'inline', input: 'Hex for gold is _', expected: { span: 'Hex for gold is _', question: 'What is hex for gold?', answer: '#FFD700', answerAlternates: ['#ffd700'] } },
  { id: 'cb-hex-for-silver-is', category: 'inline', input: 'Hex for silver is _', expected: { span: 'Hex for silver is _', question: 'What is hex for silver?', answer: '#C0C0C0', answerAlternates: ['#c0c0c0'] } },
];
