import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    { path: "/api/shop/airtime/initialize", method: "POST" },
    { path: "/api/shop/results-checker/initialize", method: "POST" },
    { path: "/api/shop/orders/create", method: "POST" },
  ],
});
