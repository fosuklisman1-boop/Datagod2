import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    { path: "/api/shop/airtime/initialize", method: "POST" },
    { path: "/api/payments/initialize", method: "POST" },
  ],
});
