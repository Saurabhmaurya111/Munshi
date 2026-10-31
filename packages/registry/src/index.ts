/** Tool cards and domain packs. */

export type ToolRisk = "read" | "write" | "money";

export type ToolCard = {
  name: string;
  description: string;
  risk: ToolRisk;
  domainPack: string;
};
