import { createRouter, createWebHistory } from 'vue-router';
import App from '../App.vue';

const routes = [
  {
    path: '/upload',
    name: 'Upload',
    component: App
  }
];

const router = createRouter({
  history: createWebHistory('/upload'),
  routes
});

export default router; 