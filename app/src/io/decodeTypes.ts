import type { SplatArrays } from '../model/SplatStore';
import type { PointCloudInfo } from './pointCloud';

export interface DecodeOptions {
  pointBudget?: number;
  pointSizeMul?: number;
}

export interface DecodeProgress {
  phase: 'parsing';
  loaded: number;
  total: number;
}

export interface DecodedSplats {
  arrays: SplatArrays;
  kind: 'scan' | 'pointcloud';
  pointCloud?: PointCloudInfo;
  lossy?: string;
  warnings?: string[];
}
