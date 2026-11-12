import { authkitDoctorChecks } from './agora_checks.js';
import type { AgoraDoctorCheck } from './agora_doctor.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorRegistry,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { AGORA_DOCTOR_BINDING, registerDoctorChecks } from './agora_doctor.js';

/** authkit's checks, for `node ace agora:doctor --no-boot` (which imports this entry instead of booting). */
export const agoraDoctorChecks: AgoraDoctorCheck[] = authkitDoctorChecks();
