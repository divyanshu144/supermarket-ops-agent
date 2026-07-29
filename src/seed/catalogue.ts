import type { Unit } from '../domain/units.js';

export interface SeedProduct {
  name: string;
  brand?: string;
  packSize?: string;
  unit: Unit;
  isLoose?: boolean;
  hsnCode: string;
  gstRateBps: number;
  costPricePaise: number;
  mrpPaise: number;
  openingBase: number;
  reorderLevelBase: number;
}

/**
 * Real SKUs from the brief. GST slabs follow Indian practice: loose staples 0%, packaged
 * staples 5%, FMCG 12–18%. MRPs are tax-INCLUSIVE — see domain/gst.ts.
 */
export const CATALOGUE: SeedProduct[] = [
  {
    name: 'Aashirvaad Atta 5kg',
    brand: 'Aashirvaad',
    packSize: '5kg',
    unit: 'packet',
    hsnCode: '11010000',
    gstRateBps: 500,
    costPricePaise: 22000,
    mrpPaise: 26000,
    openingBase: 14,
    reorderLevelBase: 5,
  },
  {
    name: 'Tata Salt 1kg',
    brand: 'Tata',
    packSize: '1kg',
    unit: 'packet',
    hsnCode: '25010020',
    gstRateBps: 500,
    costPricePaise: 2200,
    mrpPaise: 2800,
    openingBase: 30,
    reorderLevelBase: 10,
  },
  {
    name: 'Amul Butter 100g',
    brand: 'Amul',
    packSize: '100g',
    unit: 'packet',
    hsnCode: '04059020',
    gstRateBps: 1200,
    costPricePaise: 5200,
    mrpPaise: 6200,
    openingBase: 18,
    reorderLevelBase: 6,
  },
  {
    name: 'Fortune Sunflower Oil 1L',
    brand: 'Fortune',
    packSize: '1L',
    unit: 'packet',
    hsnCode: '15121110',
    gstRateBps: 500,
    costPricePaise: 13500,
    mrpPaise: 15500,
    openingBase: 12,
    reorderLevelBase: 4,
  },
  {
    name: 'Maggi 70g',
    brand: 'Nestle',
    packSize: '70g',
    unit: 'packet',
    hsnCode: '19023010',
    gstRateBps: 1200,
    costPricePaise: 1200,
    mrpPaise: 1400,
    // Deliberately low so the oversell guard is easy to trigger on camera.
    openingBase: 6,
    reorderLevelBase: 12,
  },
  {
    name: 'Parle-G 100g',
    brand: 'Parle',
    packSize: '100g',
    unit: 'packet',
    hsnCode: '19053100',
    gstRateBps: 1800,
    costPricePaise: 800,
    mrpPaise: 1000,
    openingBase: 40,
    reorderLevelBase: 15,
  },
  {
    name: 'Surf Excel 1kg',
    brand: 'Surf Excel',
    packSize: '1kg',
    unit: 'packet',
    hsnCode: '34022090',
    gstRateBps: 1800,
    costPricePaise: 11000,
    mrpPaise: 13500,
    // At reorder level so "what's running out?" returns something real.
    openingBase: 3,
    reorderLevelBase: 5,
  },
  {
    name: 'Sugar (loose)',
    unit: 'kg',
    isLoose: true,
    hsnCode: '17019990',
    gstRateBps: 0,
    costPricePaise: 4200,
    mrpPaise: 5200,
    openingBase: 18_000,
    reorderLevelBase: 5_000,
  },
  {
    name: 'Rice (loose)',
    unit: 'kg',
    isLoose: true,
    hsnCode: '10063020',
    gstRateBps: 0,
    costPricePaise: 5500,
    mrpPaise: 6800,
    openingBase: 40_000,
    reorderLevelBase: 10_000,
  },
  {
    name: 'Toor Dal (loose)',
    unit: 'kg',
    isLoose: true,
    hsnCode: '07136000',
    gstRateBps: 0,
    costPricePaise: 11000,
    mrpPaise: 13500,
    openingBase: 22_000,
    reorderLevelBase: 8_000,
  },
];

export const SEED_KHATA = [
  { customerName: 'Ramesh', phone: '9820011223', openingBalancePaise: 48_500 },
  { customerName: 'Sunita', phone: '9820044556', openingBalancePaise: 12_000 },
  { customerName: 'Imran', phone: '9820077889', openingBalancePaise: 0 },
];
