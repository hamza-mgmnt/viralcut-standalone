/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./lib/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0f14",
        panel: "#12181f",
        accent: "#ff5c1f",
        gold: "#ffc233",
      },
    },
  },
  plugins: [],
};
