export interface Account {
  account: string;
  type: string;
  balance: string;
}

export interface Member {
  id: string;
  name: string;
  status: "Active" | "Restricted";
  phone: string;
  accounts: Account[];
}

const names = [
  "Jamie Carter",
  "Morgan Patel",
  "Taylor Rivera",
  "Jordan Lee",
  "Casey Williams",
  "Riley Thompson",
  "Avery Brooks",
  "Quinn Parker",
  "Cameron Reed",
  "Drew Bennett"
];

export const members = new Map<string, Member>(
  names.map((name, index) => {
    const id = String(1001 + index);
    return [
      id,
      {
        id,
        name,
        status: "Active" as const,
        phone: `(555) 01${String(index).padStart(2, "0")}`,
        accounts: [
          { account: `S01-${id}`, type: "Regular Savings", balance: `$${(1200 + index * 137.21).toFixed(2)}` },
          { account: `C02-${id}`, type: "Checking", balance: `$${(840 + index * 91.77).toFixed(2)}` }
        ]
      }
    ];
  })
);

members.set("4521", {
  id: "4521",
  name: "Alex Testman",
  status: "Active",
  phone: "(555) 0145",
  accounts: [
    { account: "S01-4521", type: "Regular Savings", balance: "$2,481.13" },
    { account: "C02-4521", type: "Checking", balance: "$915.42" }
  ]
});

members.set("8832", {
  id: "8832",
  name: "Sam Example",
  status: "Active",
  phone: "(555) 0188",
  accounts: [
    { account: "S01-8832", type: "Regular Savings", balance: "$3,109.08" },
    { account: "C02-8832", type: "Checking", balance: "$441.90" }
  ]
});

members.set("7777", {
  id: "7777",
  name: "Restricted Record",
  status: "Restricted",
  phone: "(555) 0177",
  accounts: []
});
