// Kubernetes cluster management UI, contributed through the extension system.
// Fully self-contained in the extension. After sync this folder lives at
// frontend/src/plugins/serverkit-k8s/, so '@/…' host aliases resolve.
export { default as K8sPage } from './components/K8sPage.jsx';

// No default export on purpose: PluginLoader legacy-auto-renders any plugin
// default export globally. The route contribution resolves the NAMED export.
