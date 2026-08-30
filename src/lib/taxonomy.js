/** Controlled vocabularies used across forms, filters and the API surface. */

const TYPES = [
  { value: 'company',      label: 'Company' },
  { value: 'startup',      label: 'Startup' },
  { value: 'agency',       label: 'Agency' },
  { value: 'organization', label: 'Organization' },
  { value: 'product',      label: 'Product' },
  { value: 'service',      label: 'Service' },
  { value: 'publisher',    label: 'Publisher' },
];

const CATEGORIES = [
  'Software & SaaS', 'Fintech', 'E-commerce & Retail', 'Marketing & Creative',
  'Media & Publishing', 'Data & Analytics', 'Cloud & Infrastructure',
  'Health & Wellness', 'Education', 'AgriTech', 'Energy & Environment',
  'Logistics & Transport', 'Finance & Investment', 'Telecommunications',
  'Professional Services', 'Real Estate & Construction', 'Travel & Hospitality',
  'Government & Non-profit', 'Manufacturing', 'Other',
];

const SIZES = ['1–10', '11–50', '51–200', '201–500', '501–1,000', '1,000+'];

const COUNTRIES = [
  'Kenya', 'Uganda', 'Tanzania', 'Rwanda', 'Ethiopia', 'Nigeria', 'Ghana',
  'South Africa', 'Egypt', 'United Kingdom', 'United States', 'Germany',
  'United Arab Emirates', 'India', 'Singapore', 'Other',
];

const typeLabel = (v) => (TYPES.find((t) => t.value === v) || {}).label || v;

module.exports = { TYPES, CATEGORIES, SIZES, COUNTRIES, typeLabel };
