// Set per environment in Vercel (Production: "prod", Pre-Production: "qa").
// NEXT_PUBLIC_* values are inlined at build time.
export const isQA = process.env.NEXT_PUBLIC_APP_ENV === 'qa';
