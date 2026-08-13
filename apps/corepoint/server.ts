import { createCorePointApp } from "./app.js";
import { tenants } from "./tenants.js";

for (const tenant of tenants) {
  createCorePointApp(tenant).listen(tenant.port, () => {
    console.log(`${tenant.brand} CorePoint tenant ${tenant.id.toUpperCase()} listening on http://localhost:${tenant.port}${tenant.entryPath}`);
  });
}
