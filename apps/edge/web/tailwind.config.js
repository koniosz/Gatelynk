/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Color palette nie używamy Tailwind — wszystko z `tokens.css` (CSS variables).
  // Tailwind tylko do utility classes (flex, gap, padding, font-size, etc.).
  // To zgodne z handoff doc — „vanilla CSS z :root zmiennymi (mockup pokazuje że vanilla wystarcza)".
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
  // Disable preflight żeby nie kolidować z naszym tokens.css :root resetem.
  corePlugins: {
    preflight: true,
  },
}
