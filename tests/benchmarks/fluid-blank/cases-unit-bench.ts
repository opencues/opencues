/** Ported UNIT benchmark cases (20). */

import { FluidBlankCase } from './cases';

export const CASES_UNIT_BENCH: FluidBlankCase[] = [
  { id: 'ub-100-celsius-in-fahrenheit', category: 'inline', input: '100 celsius in fahrenheit = _', expected: { span: '100 celsius in fahrenheit = _', question: 'What is 100 celsius in fahrenheit?', answer: '212', answerAlternates: ['212.0'] } },
  { id: 'ub-32-fahrenheit-in-celsius', category: 'inline', input: '32 fahrenheit in celsius = _', expected: { span: '32 fahrenheit in celsius = _', question: 'What is 32 fahrenheit in celsius?', answer: '0', answerAlternates: ['0.0'] } },
  { id: 'ub-5-miles-in-km', category: 'inline', input: '5 miles in km = _', expected: { span: '5 miles in km = _', question: 'What is 5 miles in km?', answer: '8.05', answerAlternates: ['8.0467', '8.05', '8.0', '8'] } },
  { id: 'ub-10-km-in-miles', category: 'inline', input: '10 km in miles = _', expected: { span: '10 km in miles = _', question: 'What is 10 km in miles?', answer: '6.21', answerAlternates: ['6.2137', '6.21', '6.2'] } },
  { id: 'ub-70-kg-in-pounds', category: 'inline', input: '70 kg in pounds = _', expected: { span: '70 kg in pounds = _', question: 'What is 70 kg in pounds?', answer: '154', answerAlternates: ['154.32', '154.3', '154.32', '154'] } },
  { id: 'ub-150-pounds-in-kg', category: 'inline', input: '150 pounds in kg = _', expected: { span: '150 pounds in kg = _', question: 'What is 150 pounds in kg?', answer: '68', answerAlternates: ['68.04', '68.0388', '68'] } },
  { id: 'ub-10-meters-in-feet', category: 'inline', input: '10 meters in feet = _', expected: { span: '10 meters in feet = _', question: 'What is 10 meters in feet?', answer: '32.81', answerAlternates: ['32.8084', '32.81', '32.8'] } },
  { id: 'ub-6-feet-in-meters', category: 'inline', input: '6 feet in meters = _', expected: { span: '6 feet in meters = _', question: 'What is 6 feet in meters?', answer: '1.83', answerAlternates: ['1.8288', '1.83', '1.8'] } },
  { id: 'ub-12-inches-in-cm', category: 'inline', input: '12 inches in cm = _', expected: { span: '12 inches in cm = _', question: 'What is 12 inches in cm?', answer: '30.48', answerAlternates: ['30.48'] } },
  { id: 'ub-100-cm-in-inches', category: 'inline', input: '100 cm in inches = _', expected: { span: '100 cm in inches = _', question: 'What is 100 cm in inches?', answer: '39.37', answerAlternates: ['39.3701', '39.37', '39.4'] } },
  { id: 'ub-5-liters-in-gallons', category: 'inline', input: '5 liters in gallons = _', expected: { span: '5 liters in gallons = _', question: 'What is 5 liters in gallons?', answer: '1.32', answerAlternates: ['1.3209', '1.32', '1.3'] } },
  { id: 'ub-10-gallons-in-liters', category: 'inline', input: '10 gallons in liters = _', expected: { span: '10 gallons in liters = _', question: 'What is 10 gallons in liters?', answer: '37.85', answerAlternates: ['37.8541', '37.85', '37.9'] } },
  { id: 'ub-2-yards-in-meters', category: 'inline', input: '2 yards in meters = _', expected: { span: '2 yards in meters = _', question: 'What is 2 yards in meters?', answer: '1.83', answerAlternates: ['1.8288', '1.83', '1.8'] } },
  { id: 'ub-8-ounces-in-grams', category: 'inline', input: '8 ounces in grams = _', expected: { span: '8 ounces in grams = _', question: 'What is 8 ounces in grams?', answer: '226.8', answerAlternates: ['226.796', '226.8', '227'] } },
  { id: 'ub-40-fahrenheit-in-celsius', category: 'inline', input: '40 fahrenheit in celsius = _', expected: { span: '40 fahrenheit in celsius = _', question: 'What is 40 fahrenheit in celsius?', answer: '4.4', answerAlternates: ['4.44', '4.4', '4'] } },
  { id: 'ub-200-km-in-miles', category: 'inline', input: '200 km in miles = _', expected: { span: '200 km in miles = _', question: 'What is 200 km in miles?', answer: '124.27', answerAlternates: ['124.2742', '124.27', '124'] } },
  { id: 'ub-50-kg-in-pounds', category: 'inline', input: '50 kg in pounds = _', expected: { span: '50 kg in pounds = _', question: 'What is 50 kg in pounds?', answer: '110.23', answerAlternates: ['110.231', '110.2', '110'] } },
  { id: 'ub-3-feet-in-meters', category: 'inline', input: '3 feet in meters = _', expected: { span: '3 feet in meters = _', question: 'What is 3 feet in meters?', answer: '0.91', answerAlternates: ['0.9144', '0.91', '0.9'] } },
  { id: 'ub-500-grams-in-pounds', category: 'inline', input: '500 grams in pounds = _', expected: { span: '500 grams in pounds = _', question: 'What is 500 grams in pounds?', answer: '1.10', answerAlternates: ['1.1023', '1.10', '1.1'] } },
  { id: 'ub-20-yards-in-meters', category: 'inline', input: '20 yards in meters = _', expected: { span: '20 yards in meters = _', question: 'What is 20 yards in meters?', answer: '18.29', answerAlternates: ['18.288', '18.29', '18.3'] } },
];
