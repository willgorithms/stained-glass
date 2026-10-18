import { defineConfig } from 'vite'

// Relative asset URLs so the build works under any mount path — a project
// page (user.github.io/<repo>/), a custom domain root, or `vite preview`.
export default defineConfig({
  base: './',
})
