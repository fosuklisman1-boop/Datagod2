import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    { path: "/api/shop/airtime/initialize", method: "POST" },
    { path: "/api/shop/results-checker/initialize", method: "POST" },
    { path: "/api/auth/signup", method: "POST" },
    { path: "/api/auth/forgot-password", method: "POST" },
    { path: "/api/auth/check-phone", method: "POST" },
  ],
});
