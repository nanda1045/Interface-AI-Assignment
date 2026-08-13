export interface TenantConfig {
  id: "a" | "b";
  port: number;
  brand: string;
  entryPath: string;
  memberLabel: string;
  memberField: string;
  accountsColumns: readonly ("account" | "type" | "balance")[];
  accent: string;
}

export const tenants: readonly TenantConfig[] = [
  {
    id: "a",
    port: 4478,
    brand: "Lakeview Community Credit Union",
    entryPath: "/desk",
    memberLabel: "Member No.",
    memberField: "f_mno",
    accountsColumns: ["account", "type", "balance"],
    accent: "#174a7e"
  },
  {
    id: "b",
    port: 4479,
    brand: "Prairie Trust Financial",
    entryPath: "/operations",
    memberLabel: "Acct Holder ID",
    memberField: "f_ahid",
    accountsColumns: ["type", "balance", "account"],
    accent: "#57411f"
  }
] as const;
