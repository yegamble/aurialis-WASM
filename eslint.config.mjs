import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "internal/webui/**",
      "public/**",
      "docs/design/figma-make-reference/**",
      "e2e/**",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "jsx-a11y": jsxA11y,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react",
              message: "External icon libraries are forbidden; use src/components/shared/Icon.tsx custom inline SVGs.",
            },
            {
              name: "@heroicons/react",
              message: "External icon libraries are forbidden; use src/components/shared/Icon.tsx custom inline SVGs.",
            },
            {
              name: "react-icons",
              message: "External icon libraries are forbidden; use src/components/shared/Icon.tsx custom inline SVGs.",
            },
            {
              name: "feather-icons",
              message: "External icon libraries are forbidden; use src/components/shared/Icon.tsx custom inline SVGs.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
    },
  }
);
