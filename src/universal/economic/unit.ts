/**
 * Economic units.
 *
 * There are no currencies in GOIP. There are economic units, and USD is one of
 * them, indistinguishable at the type level from loyalty points, carbon
 * kilograms, Mars credits or an instrument nobody has invented yet. Everything
 * a unit needs to be arithmetically correct is declared here as data.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";

/**
 * How a unit behaves, not what it is called. The class decides which policies
 * apply (e.g. a non-transferable points unit may never fund a cash payout).
 */
export interface EconomicUnitClass extends RegistryEntry {
  /** May balances be moved between holders? */
  readonly transferable: boolean;
  /** May the unit be exchanged for another unit via the exchange registry? */
  readonly exchangeable: boolean;
  /** Does a balance in this unit represent a liability on someone's books? */
  readonly liability: boolean;
}

export interface EconomicUnit extends RegistryEntry {
  /** Display symbol. Presentation only; never used for arithmetic or matching. */
  readonly symbol?: string;
  /**
   * Number of decimal places. All amounts are integers of 10^-scale units, so
   * USD has scale 2 and stores cents. Points typically have scale 0. Units with
   * no smallest division (an entitlement) also use scale 0.
   */
  readonly scale: number;
  /** Key into the economic-unit-class registry. */
  readonly unitClass: string;
  /** False for one-of-a-kind instruments (a specific seat, a named licence). */
  readonly fungible: boolean;
}

export const DEFAULT_UNIT_CLASSES: EconomicUnitClass[] = [
  {
    key: "fiat",
    label: "Fiat currency",
    description: "State-issued currency. Transferable, exchangeable, settles as real money.",
    transferable: true,
    exchangeable: true,
    liability: true,
  },
  {
    key: "scrip",
    label: "Closed-loop scrip",
    description: "Issuer-redeemable value: store credit, wallet balance, gift-card value.",
    transferable: true,
    exchangeable: false,
    liability: true,
  },
  {
    key: "points",
    label: "Loyalty points",
    description: "Programme currency with no direct cash claim. Usually non-transferable.",
    transferable: false,
    exchangeable: true,
    liability: true,
  },
  {
    key: "resource",
    label: "Resource unit",
    description: "A physical or metered quantity: kWh, carbon kg, bandwidth, water litres.",
    transferable: true,
    exchangeable: true,
    liability: false,
  },
  {
    key: "entitlement",
    label: "Entitlement",
    description: "A countable right rather than a value: seats, passes, admissions, uses.",
    transferable: false,
    exchangeable: false,
    liability: false,
  },
];

/**
 * Seed units. These are examples, not a closed world - a tenant registers its
 * own, and the platform never refers to any of these keys in code.
 */
export const DEFAULT_ECONOMIC_UNITS: EconomicUnit[] = [
  { key: "USD", label: "US Dollar", symbol: "$", scale: 2, unitClass: "fiat", fungible: true },
  { key: "EUR", label: "Euro", symbol: "€", scale: 2, unitClass: "fiat", fungible: true },
  { key: "INR", label: "Indian Rupee", symbol: "₹", scale: 2, unitClass: "fiat", fungible: true },
  { key: "JPY", label: "Japanese Yen", symbol: "¥", scale: 0, unitClass: "fiat", fungible: true },
  { key: "BHD", label: "Bahraini Dinar", symbol: "BD", scale: 3, unitClass: "fiat", fungible: true },
  { key: "STORE_CREDIT", label: "Store credit", scale: 2, unitClass: "scrip", fungible: true },
  { key: "POINTS", label: "Loyalty points", scale: 0, unitClass: "points", fungible: true },
  { key: "COINS", label: "Game coins", scale: 0, unitClass: "points", fungible: true },
  { key: "CARBON_KG", label: "Carbon credit (kg)", scale: 3, unitClass: "resource", fungible: true },
  { key: "ENERGY_KWH", label: "Energy credit (kWh)", scale: 3, unitClass: "resource", fungible: true },
  { key: "SEAT", label: "Reserved seat", scale: 0, unitClass: "entitlement", fungible: false },
  { key: "MARS_CREDIT", label: "Mars colonial credit", scale: 4, unitClass: "fiat", fungible: true },
  { key: "FED_CREDIT", label: "Federation credit", scale: 6, unitClass: "fiat", fungible: true },
];

export function economicUnitRegistry(): Registry<EconomicUnit> {
  return new Registry<EconomicUnit>("economic-unit").registerAll(DEFAULT_ECONOMIC_UNITS);
}

export function economicUnitClassRegistry(): Registry<EconomicUnitClass> {
  return new Registry<EconomicUnitClass>("economic-unit-class").registerAll(DEFAULT_UNIT_CLASSES);
}
