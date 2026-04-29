/** Ported ROMAN benchmark cases (20). */

import { FluidBlankCase } from './cases';

export const CASES_ROMAN_BENCH: FluidBlankCase[] = [
  { id: 'rb-14-in-roman-numerals-is', category: 'inline', input: '14 in roman numerals is _', expected: { span: '14 in roman numerals is _', question: 'What is 14 in roman numerals?', answer: 'XIV', answerAlternates: [] } },
  { id: 'rb-2024-in-roman-numerals-is', category: 'inline', input: '2024 in roman numerals is _', expected: { span: '2024 in roman numerals is _', question: 'What is 2024 in roman numerals?', answer: 'MMXXIV', answerAlternates: [] } },
  { id: 'rb-99-in-roman-numerals-is', category: 'inline', input: '99 in roman numerals is _', expected: { span: '99 in roman numerals is _', question: 'What is 99 in roman numerals?', answer: 'XCIX', answerAlternates: [] } },
  { id: 'rb-1990-in-roman-numerals-is', category: 'inline', input: '1990 in roman numerals is _', expected: { span: '1990 in roman numerals is _', question: 'What is 1990 in roman numerals?', answer: 'MCMXC', answerAlternates: [] } },
  { id: 'rb-500-in-roman-numerals-is', category: 'inline', input: '500 in roman numerals is _', expected: { span: '500 in roman numerals is _', question: 'What is 500 in roman numerals?', answer: 'D', answerAlternates: [] } },
  { id: 'rb-49-in-roman-numerals-is', category: 'inline', input: '49 in roman numerals is _', expected: { span: '49 in roman numerals is _', question: 'What is 49 in roman numerals?', answer: 'XLIX', answerAlternates: [] } },
  { id: 'rb-100-in-roman-numerals-is', category: 'inline', input: '100 in roman numerals is _', expected: { span: '100 in roman numerals is _', question: 'What is 100 in roman numerals?', answer: 'C', answerAlternates: [] } },
  { id: 'rb-1000-in-roman-numerals-is', category: 'inline', input: '1000 in roman numerals is _', expected: { span: '1000 in roman numerals is _', question: 'What is 1000 in roman numerals?', answer: 'M', answerAlternates: [] } },
  { id: 'rb-1492-in-roman-numerals-is', category: 'inline', input: '1492 in roman numerals is _', expected: { span: '1492 in roman numerals is _', question: 'What is 1492 in roman numerals?', answer: 'MCDXCII', answerAlternates: [] } },
  { id: 'rb-77-in-roman-numerals-is', category: 'inline', input: '77 in roman numerals is _', expected: { span: '77 in roman numerals is _', question: 'What is 77 in roman numerals?', answer: 'LXXVII', answerAlternates: [] } },
  { id: 'rb-mcmxc-in-numbers-is', category: 'inline', input: 'MCMXC in numbers is _', expected: { span: 'MCMXC in numbers is _', question: 'What is mCMXC in numbers?', answer: '1990', answerAlternates: [] } },
  { id: 'rb-xiv-in-numbers-is', category: 'inline', input: 'XIV in numbers is _', expected: { span: 'XIV in numbers is _', question: 'What is xIV in numbers?', answer: '14', answerAlternates: [] } },
  { id: 'rb-xlii-in-numbers-is', category: 'inline', input: 'XLII in numbers is _', expected: { span: 'XLII in numbers is _', question: 'What is xLII in numbers?', answer: '42', answerAlternates: [] } },
  { id: 'rb-mmxxiv-in-numbers-is', category: 'inline', input: 'MMXXIV in numbers is _', expected: { span: 'MMXXIV in numbers is _', question: 'What is mMXXIV in numbers?', answer: '2024', answerAlternates: [] } },
  { id: 'rb-ix-in-numbers-is', category: 'inline', input: 'IX in numbers is _', expected: { span: 'IX in numbers is _', question: 'What is iX in numbers?', answer: '9', answerAlternates: [] } },
  { id: 'rb-cdxliv-in-numbers-is', category: 'inline', input: 'CDXLIV in numbers is _', expected: { span: 'CDXLIV in numbers is _', question: 'What is cDXLIV in numbers?', answer: '444', answerAlternates: [] } },
  { id: 'rb-dccclxxxviii-in-numbers-is', category: 'inline', input: 'DCCCLXXXVIII in numbers is _', expected: { span: 'DCCCLXXXVIII in numbers is _', question: 'What is dCCCLXXXVIII in numbers?', answer: '888', answerAlternates: [] } },
  { id: 'rb-lvi-in-numbers-is', category: 'inline', input: 'LVI in numbers is _', expected: { span: 'LVI in numbers is _', question: 'What is lVI in numbers?', answer: '56', answerAlternates: [] } },
  { id: 'rb-ccclx-in-numbers-is', category: 'inline', input: 'CCCLX in numbers is _', expected: { span: 'CCCLX in numbers is _', question: 'What is cCCLX in numbers?', answer: '360', answerAlternates: [] } },
  { id: 'rb-mmi-in-numbers-is', category: 'inline', input: 'MMI in numbers is _', expected: { span: 'MMI in numbers is _', question: 'What is mMI in numbers?', answer: '2001', answerAlternates: [] } },
];
