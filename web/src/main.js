import * as Sentry from "@sentry/vue";
import "bootstrap/dist/css/bootstrap.css";
import { createApp } from "vue";
import App from "./App.vue";
import router from './router';
const app = createApp(App);

Sentry.init({
  app,
  dsn: "https://1ad03b81432243f58fd49388418e892b@o4505286646038528.ingest.sentry.io/4505306287964160",
  integrations: [new Sentry.Replay()],
  // Session Replay
  replaysSessionSampleRate: 0.1, // This sets the sample rate at 10%. You may want to change it to 100% while in development and then sample at a lower rate in production.
  replaysOnErrorSampleRate: 1.0, // If you're not already sampling the entire session, change the sample rate to 100% when sampling sessions where errors occur.
});

app.use(router);
app.mount("#app");
