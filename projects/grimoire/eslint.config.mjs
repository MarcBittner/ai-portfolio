// ESLint 9 flat config. Next 16 removed `next lint`, so linting runs ESLint
// directly (`npm run lint` → `eslint .`). eslint-config-next v16 ships native flat
// configs, spread in directly (FlatCompat is not needed / incompatible here).
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: [".next/**", "node_modules/**", "services/**"] },
];

export default eslintConfig;
