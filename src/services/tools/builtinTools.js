/**
 * Built-in Tools for Buddvisor
 * Provides tax calculations, financial utilities, and business tools
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');

/**
 * Register all built-in tools
 */
function registerBuiltinTools() {
  // ============================================
  // TAX CALCULATION TOOLS
  // ============================================

  // toolRegistry.register({
  //   name: 'calculate_federal_income_tax',
  //   description: 'Calculate estimated federal income tax based on taxable income and filing status for a given tax year',
  //   category: 'tax',
  //   parameters: {
  //     taxable_income: {
  //       type: 'number',
  //       description: 'Total taxable income in dollars',
  //       required: true,
  //       minimum: 0,
  //     },
  //     filing_status: {
  //       type: 'string',
  //       description: 'Tax filing status',
  //       required: true,
  //       enum: ['single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household'],
  //     },
  //     tax_year: {
  //       type: 'number',
  //       description: 'Tax year (default: current year)',
  //       required: false,
  //       minimum: 2020,
  //       maximum: 2026,
  //     },
  //   },
  //   handler: (params) => {
  //     const { taxable_income, filing_status, tax_year = 2024 } = params;

  //     // 2024 tax brackets (simplified)
  //     const brackets = {
  //       single: [
  //         { min: 0, max: 11600, rate: 0.10 },
  //         { min: 11600, max: 47150, rate: 0.12 },
  //         { min: 47150, max: 100525, rate: 0.22 },
  //         { min: 100525, max: 191950, rate: 0.24 },
  //         { min: 191950, max: 243725, rate: 0.32 },
  //         { min: 243725, max: 609350, rate: 0.35 },
  //         { min: 609350, max: Infinity, rate: 0.37 },
  //       ],
  //       married_filing_jointly: [
  //         { min: 0, max: 23200, rate: 0.10 },
  //         { min: 23200, max: 94300, rate: 0.12 },
  //         { min: 94300, max: 201050, rate: 0.22 },
  //         { min: 201050, max: 383900, rate: 0.24 },
  //         { min: 383900, max: 487450, rate: 0.32 },
  //         { min: 487450, max: 731200, rate: 0.35 },
  //         { min: 731200, max: Infinity, rate: 0.37 },
  //       ],
  //       married_filing_separately: [
  //         { min: 0, max: 11600, rate: 0.10 },
  //         { min: 11600, max: 47150, rate: 0.12 },
  //         { min: 47150, max: 100525, rate: 0.22 },
  //         { min: 100525, max: 191950, rate: 0.24 },
  //         { min: 191950, max: 243725, rate: 0.32 },
  //         { min: 243725, max: 365600, rate: 0.35 },
  //         { min: 365600, max: Infinity, rate: 0.37 },
  //       ],
  //       head_of_household: [
  //         { min: 0, max: 16550, rate: 0.10 },
  //         { min: 16550, max: 63100, rate: 0.12 },
  //         { min: 63100, max: 100500, rate: 0.22 },
  //         { min: 100500, max: 191950, rate: 0.24 },
  //         { min: 191950, max: 243700, rate: 0.32 },
  //         { min: 243700, max: 609350, rate: 0.35 },
  //         { min: 609350, max: Infinity, rate: 0.37 },
  //       ],
  //     };

  //     const taxBrackets = brackets[filing_status];
  //     let tax = 0;
  //     let remainingIncome = taxable_income;
  //     const breakdown = [];

  //     for (const bracket of taxBrackets) {
  //       if (remainingIncome <= 0) break;

  //       const taxableInBracket = Math.min(
  //         remainingIncome,
  //         bracket.max - bracket.min
  //       );

  //       const taxInBracket = taxableInBracket * bracket.rate;
  //       tax += taxInBracket;

  //       if (taxableInBracket > 0) {
  //         breakdown.push({
  //           bracket: `${(bracket.rate * 100).toFixed(0)}%`,
  //           income: taxableInBracket,
  //           tax: taxInBracket,
  //         });
  //       }

  //       remainingIncome -= taxableInBracket;
  //     }

  //     const effectiveRate = taxable_income > 0 ? (tax / taxable_income) * 100 : 0;

  //     return {
  //       taxable_income,
  //       filing_status,
  //       tax_year,
  //       estimated_tax: Math.round(tax * 100) / 100,
  //       effective_rate: effectiveRate.toFixed(2) + '%',
  //       marginal_rate: breakdown.length > 0 ? breakdown[breakdown.length - 1].bracket : '0%',
  //       breakdown,
  //       disclaimer: 'This is an estimate only. Consult a tax professional for accurate tax advice.',
  //     };
  //   },
  //   examples: [
  //     { taxable_income: 75000, filing_status: 'single' },
  //     { taxable_income: 150000, filing_status: 'married_filing_jointly' },
  //   ],
  // });

  // toolRegistry.register({
  //   name: 'calculate_self_employment_tax',
  //   description: 'Calculate self-employment tax (Social Security and Medicare) for self-employed individuals',
  //   category: 'tax',
  //   parameters: {
  //     net_self_employment_income: {
  //       type: 'number',
  //       description: 'Net self-employment income after business expenses',
  //       required: true,
  //       minimum: 0,
  //     },
  //     tax_year: {
  //       type: 'number',
  //       description: 'Tax year',
  //       required: false,
  //     },
  //   },
  //   handler: (params) => {
  //     const { net_self_employment_income, tax_year = 2024 } = params;

  //     // 2024 rates
  //     const socialSecurityRate = 0.124; // 12.4%
  //     const medicareRate = 0.029; // 2.9%
  //     const socialSecurityWageBase = 168600; // 2024 limit
  //     const additionalMedicareThreshold = 200000;
  //     const additionalMedicareRate = 0.009; // 0.9%

  //     // Calculate 92.35% of net SE income (the taxable portion)
  //     const taxableIncome = net_self_employment_income * 0.9235;

  //     // Social Security tax (capped at wage base)
  //     const socialSecurityTaxable = Math.min(taxableIncome, socialSecurityWageBase);
  //     const socialSecurityTax = socialSecurityTaxable * socialSecurityRate;

  //     // Medicare tax (no cap)
  //     const medicareTax = taxableIncome * medicareRate;

  //     // Additional Medicare tax
  //     let additionalMedicareTax = 0;
  //     if (taxableIncome > additionalMedicareThreshold) {
  //       additionalMedicareTax = (taxableIncome - additionalMedicareThreshold) * additionalMedicareRate;
  //     }

  //     const totalSETax = socialSecurityTax + medicareTax + additionalMedicareTax;

  //     // Deductible portion (half of SE tax)
  //     const deductiblePortion = totalSETax / 2;

  //     return {
  //       net_self_employment_income,
  //       taxable_se_income: Math.round(taxableIncome * 100) / 100,
  //       social_security_tax: Math.round(socialSecurityTax * 100) / 100,
  //       medicare_tax: Math.round(medicareTax * 100) / 100,
  //       additional_medicare_tax: Math.round(additionalMedicareTax * 100) / 100,
  //       total_se_tax: Math.round(totalSETax * 100) / 100,
  //       deductible_portion: Math.round(deductiblePortion * 100) / 100,
  //       effective_rate: ((totalSETax / net_self_employment_income) * 100).toFixed(2) + '%',
  //       tax_year,
  //     };
  //   },
  // });

  // toolRegistry.register({
  //   name: 'calculate_quarterly_estimated_tax',
  //   description: 'Calculate quarterly estimated tax payments based on expected annual income',
  //   category: 'tax',
  //   parameters: {
  //     expected_annual_income: {
  //       type: 'number',
  //       description: 'Expected total annual income',
  //       required: true,
  //       minimum: 0,
  //     },
  //     expected_withholding: {
  //       type: 'number',
  //       description: 'Expected total tax withholding for the year',
  //       required: false,
  //     },
  //     filing_status: {
  //       type: 'string',
  //       description: 'Tax filing status',
  //       required: true,
  //       enum: ['single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household'],
  //     },
  //     is_self_employed: {
  //       type: 'boolean',
  //       description: 'Whether the income is from self-employment',
  //       required: false,
  //     },
  //   },
  //   handler: (params) => {
  //     const {
  //       expected_annual_income,
  //       expected_withholding = 0,
  //       filing_status,
  //       is_self_employed = false,
  //     } = params;

  //     // Simplified calculation
  //     // In practice, this would use the full tax calculation
  //     let estimatedTax = expected_annual_income * 0.22; // Rough estimate

  //     if (is_self_employed) {
  //       // Add SE tax estimate
  //       estimatedTax += expected_annual_income * 0.9235 * 0.153;
  //     }

  //     const remainingTax = Math.max(0, estimatedTax - expected_withholding);
  //     const quarterlyPayment = remainingTax / 4;

  //     // Due dates for 2024
  //     const dueDates = [
  //       { quarter: 'Q1', dueDate: 'April 15, 2024', period: 'Jan 1 - Mar 31' },
  //       { quarter: 'Q2', dueDate: 'June 17, 2024', period: 'Apr 1 - May 31' },
  //       { quarter: 'Q3', dueDate: 'September 16, 2024', period: 'Jun 1 - Aug 31' },
  //       { quarter: 'Q4', dueDate: 'January 15, 2025', period: 'Sep 1 - Dec 31' },
  //     ];

  //     return {
  //       expected_annual_income,
  //       expected_withholding,
  //       estimated_annual_tax: Math.round(estimatedTax * 100) / 100,
  //       remaining_tax_due: Math.round(remainingTax * 100) / 100,
  //       quarterly_payment: Math.round(quarterlyPayment * 100) / 100,
  //       payment_schedule: dueDates.map(d => ({
  //         ...d,
  //         amount: Math.round(quarterlyPayment * 100) / 100,
  //       })),
  //       note: 'Use IRS Form 1040-ES for official calculations',
  //     };
  //   },
  // });

  // ============================================
  // UTILITY TOOLS
  // ============================================

  // toolRegistry.register({
  //   name: 'get_tax_deadlines',
  //   description: 'Get important tax deadlines for the specified year',
  //   category: 'utility',
  //   parameters: {
  //     year: {
  //       type: 'number',
  //       description: 'Tax year',
  //       required: false,
  //     },
  //     business_type: {
  //       type: 'string',
  //       description: 'Type of business entity',
  //       required: false,
  //       enum: ['individual', 'sole_proprietor', 'partnership', 's_corp', 'c_corp'],
  //     },
  //   },
  //   handler: (params) => {
  //     const { year = 2024, business_type = 'individual' } = params;

  //     const deadlines = [
  //       { date: `January 15, ${year}`, description: 'Q4 estimated tax payment due (previous year)' },
  //       { date: `January 31, ${year}`, description: 'W-2s and 1099s must be sent to recipients' },
  //       { date: `March 15, ${year}`, description: 'S-Corp and Partnership returns due (Form 1120-S, 1065)' },
  //       { date: `April 15, ${year}`, description: 'Individual and C-Corp returns due; Q1 estimated tax payment' },
  //       { date: `June 15, ${year}`, description: 'Q2 estimated tax payment due' },
  //       { date: `September 15, ${year}`, description: 'Q3 estimated tax payment; Extended S-Corp/Partnership due' },
  //       { date: `October 15, ${year}`, description: 'Extended individual and C-Corp returns due' },
  //       { date: `December 31, ${year}`, description: 'Last day for retirement contributions affecting current year' },
  //     ];

  //     // Filter based on business type
  //     let relevantDeadlines = deadlines;
  //     if (business_type === 'individual' || business_type === 'sole_proprietor') {
  //       relevantDeadlines = deadlines.filter(d =>
  //         !d.description.includes('S-Corp') && !d.description.includes('Partnership') &&
  //         !d.description.includes('C-Corp')
  //       );
  //     }

  //     return {
  //       year,
  //       business_type,
  //       deadlines: relevantDeadlines,
  //       note: 'Dates may shift if they fall on weekends or holidays. Always verify with IRS.',
  //     };
  //   },
  // });

  // toolRegistry.register({
  //   name: 'calculate_mileage_deduction',
  //   description: 'Calculate business mileage deduction using IRS standard rate',
  //   category: 'utility',
  //   parameters: {
  //     business_miles: {
  //       type: 'number',
  //       description: 'Total business miles driven',
  //       required: true,
  //       minimum: 0,
  //     },
  //     year: {
  //       type: 'number',
  //       description: 'Tax year',
  //       required: false,
  //     },
  //   },
  //   handler: (params) => {
  //     const { business_miles, year = 2024 } = params;

  //     // IRS standard mileage rates
  //     const rates = {
  //       2024: 0.67,
  //       2023: 0.655,
  //       2022: 0.625, // First half was 0.585
  //     };

  //     const rate = rates[year] || 0.67;
  //     const deduction = business_miles * rate;

  //     return {
  //       business_miles,
  //       year,
  //       standard_rate: `$${rate}/mile`,
  //       total_deduction: Math.round(deduction * 100) / 100,
  //       note: 'Alternative: Track actual vehicle expenses (gas, repairs, insurance, depreciation)',
  //     };
  //   },
  // });

  // toolRegistry.register({
  //   name: 'calculate_home_office_deduction',
  //   description: 'Calculate home office deduction using simplified or regular method',
  //   category: 'utility',
  //   parameters: {
  //     method: {
  //       type: 'string',
  //       description: 'Calculation method',
  //       required: true,
  //       enum: ['simplified', 'regular'],
  //     },
  //     square_footage: {
  //       type: 'number',
  //       description: 'Square footage of home office',
  //       required: true,
  //       minimum: 1,
  //     },
  //     total_home_sqft: {
  //       type: 'number',
  //       description: 'Total square footage of home (for regular method)',
  //       required: false,
  //     },
  //     total_home_expenses: {
  //       type: 'number',
  //       description: 'Total home expenses for year (for regular method)',
  //       required: false,
  //     },
  //   },
  //   handler: (params) => {
  //     const { method, square_footage, total_home_sqft, total_home_expenses } = params;

  //     if (method === 'simplified') {
  //       // Simplified method: $5 per sq ft, max 300 sq ft
  //       const eligibleSqft = Math.min(square_footage, 300);
  //       const deduction = eligibleSqft * 5;

  //       return {
  //         method: 'simplified',
  //         square_footage,
  //         eligible_square_footage: eligibleSqft,
  //         rate: '$5/sq ft',
  //         max_square_footage: 300,
  //         deduction: deduction,
  //         max_deduction: 1500,
  //         note: 'Simplified method caps at 300 sq ft ($1,500 max)',
  //       };
  //     } else {
  //       // Regular method
  //       if (!total_home_sqft || !total_home_expenses) {
  //         return {
  //           error: 'Regular method requires total_home_sqft and total_home_expenses',
  //         };
  //       }

  //       const businessPercentage = (square_footage / total_home_sqft) * 100;
  //       const deduction = total_home_expenses * (businessPercentage / 100);

  //       return {
  //         method: 'regular',
  //         office_square_footage: square_footage,
  //         total_home_sqft,
  //         business_use_percentage: businessPercentage.toFixed(2) + '%',
  //         total_home_expenses,
  //         deduction: Math.round(deduction * 100) / 100,
  //         note: 'Keep detailed records of all home expenses',
  //       };
  //     }
  //   },
  // });

  logger.info(`Registered ${toolRegistry.count} built-in tools`);
}

module.exports = { registerBuiltinTools };
