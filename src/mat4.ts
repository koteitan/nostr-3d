// Minimal 4x4 matrix / quaternion helpers.
// Matrices are 16 numbers in column-major order (the order of WebGL uniforms,
// CSS matrix3d() and the DOMMatrix constructor).

export type Mat4 = number[];
export type Vec3 = [number, number, number];
/** [x, y, z, w] */
export type Quat = [number, number, number, number];

/** a * b : applies b first, then a. */
export const mul = (a: Mat4, b: Mat4): Mat4 => {
  const r = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      r[col * 4 + row] = s;
    }
  }
  return r;
};

export const translation = (x: number, y: number, z: number): Mat4 => [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1,
];

export const scaling = (x: number, y: number, z: number): Mat4 => [
  x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1,
];

export const perspective = (fovY: number, aspect: number, near: number, far: number): Mat4 => {
  const t = 1 / Math.tan(fovY / 2);
  return [
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
};

export const fromQuat = ([x, y, z, w]: Quat): Mat4 => {
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
};

/** a * b : rotates by b first, then by a. */
export const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const quatNormalize = (q: Quat): Quat => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};

export const quatFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

/** The rotation that takes unit vector v0 to unit vector v1 along the shortest arc. */
export const quatBetween = (v0: Vec3, v1: Vec3): Quat => {
  const axis: Vec3 = [
    v0[1] * v1[2] - v0[2] * v1[1],
    v0[2] * v1[0] - v0[0] * v1[2],
    v0[0] * v1[1] - v0[1] * v1[0],
  ];
  const sin = Math.hypot(axis[0], axis[1], axis[2]);
  const cos = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
  if (sin < 1e-9) return [0, 0, 0, 1];
  return quatFromAxisAngle(axis, Math.atan2(sin, cos));
};

export const rotateVec = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

/** Multiplies the point (x, y, z, 1) and returns the homogeneous result. */
export const transformPoint = (m: Mat4, x: number, y: number, z: number) => ({
  x: m[0] * x + m[4] * y + m[8] * z + m[12],
  y: m[1] * x + m[5] * y + m[9] * z + m[13],
  z: m[2] * x + m[6] * y + m[10] * z + m[14],
  w: m[3] * x + m[7] * y + m[11] * z + m[15],
});
