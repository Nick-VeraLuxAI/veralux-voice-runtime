// G.722 decoder ported from g722tools (BSD-3-Clause). See LICENSE in this folder.

const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042] as const;
const RL42 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0] as const;
const ILB = [
  2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599, 2656, 2714, 2774,
  2834, 2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371, 3444, 3520, 3597, 3676, 3756, 3838,
  3922, 4008,
] as const;
const WH = [0, -214, 798] as const;
const RH2 = [2, 1, 2, 1] as const;
const QM2 = [-7408, -1616, 7408, 1616] as const;
const QM4 = [
  0, -20456, -12896, -8968, -6288, -4240, -2584, -1200, 20456, 12896, 8968, 6288, 4240, 2584,
  1200, 0,
] as const;
const QM5 = [
  -280, -280, -23352, -17560, -14120, -11664, -9752, -8184, -6864, -5712, -4696, -3784, -2960,
  -2208, -1520, -880, 23352, 17560, 14120, 11664, 9752, 8184, 6864, 5712, 4696, 3784, 2960,
  2208, 1520, 880, 280, -280,
] as const;
const QM6 = [
  -136, -136, -136, -136, -24808, -21904, -19008, -16704, -14984, -13512, -12280, -11192,
  -10232, -9360, -8576, -7856, -7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576, -3168,
  -2776, -2400, -2032, -1688, -1360, -1040, -728, 24808, 21904, 19008, 16704, 14984, 13512,
  12280, 11192, 10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456, 4944, 4464, 4008, 3576, 3168,
  2776, 2400, 2032, 1688, 1360, 1040, 728, 432, 136, -432, -136,
] as const;
const QMF_COEFFS = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11] as const;

interface G722BandState {
  s: number;
  sp: number;
  sz: number;
  r: number[];
  a: number[];
  ap: number[];
  p: number[];
  d: number[];
  b: number[];
  bp: number[];
  sg: number[];
  nb: number;
  det: number;
}

interface G722DecodeState {
  ituTestMode: boolean;
  packed: boolean;
  eightK: boolean;
  bitsPerSample: number;
  x: number[];
  band: [G722BandState, G722BandState];
  inBuffer: number;
  inBits: number;
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
}

function saturate(value: number): number {
  const amp16 = (value << 16) >> 16;
  if (value === amp16) return amp16;
  if (value > 32767) return 32767;
  return -32768;
}

function createBandState(): G722BandState {
  return {
    s: 0,
    sp: 0,
    sz: 0,
    r: [0, 0, 0],
    a: [0, 0, 0],
    ap: [0, 0, 0],
    p: [0, 0, 0],
    d: [0, 0, 0, 0, 0, 0, 0],
    b: [0, 0, 0, 0, 0, 0, 0],
    bp: [0, 0, 0, 0, 0, 0, 0],
    sg: [0, 0, 0, 0, 0, 0, 0],
    nb: 0,
    det: 0,
  };
}

function createDecodeState(rate: number, options: number): G722DecodeState {
  const bitsPerSample = rate === 48000 ? 6 : rate === 56000 ? 7 : 8;
  const eightK = (options & 0x0001) !== 0;
  const packed = (options & 0x0002) !== 0 && bitsPerSample !== 8;
  const band0 = createBandState();
  const band1 = createBandState();
  band0.det = 32;
  band1.det = 8;

  return {
    ituTestMode: false,
    packed,
    eightK,
    bitsPerSample,
    x: new Array(24).fill(0),
    band: [band0, band1],
    inBuffer: 0,
    inBits: 0,
  };
}

function block4(state: G722DecodeState, band: number, d: number): void {
  const st = state.band[band];
  let wd1 = 0;
  let wd2 = 0;
  let wd3 = 0;

  st.d[0] = d;
  st.r[0] = saturate(st.s + d);
  st.p[0] = saturate(st.sz + d);

  for (let i = 0; i < 3; i += 1) {
    st.sg[i] = st.p[i] >> 15;
  }
  wd1 = saturate(st.a[1] << 2);
  wd2 = st.sg[0] === st.sg[1] ? -wd1 : wd1;
  if (wd2 > 32767) wd2 = 32767;
  wd3 = st.sg[0] === st.sg[2] ? 128 : -128;
  wd3 += wd2 >> 7;
  wd3 += (st.a[2] * 32512) >> 15;
  if (wd3 > 12288) wd3 = 12288;
  else if (wd3 < -12288) wd3 = -12288;
  st.ap[2] = wd3;

  st.sg[0] = st.p[0] >> 15;
  st.sg[1] = st.p[1] >> 15;
  wd1 = st.sg[0] === st.sg[1] ? 192 : -192;
  wd2 = (st.a[1] * 32640) >> 15;
  st.ap[1] = saturate(wd1 + wd2);
  wd3 = saturate(15360 - st.ap[2]);
  if (st.ap[1] > wd3) st.ap[1] = wd3;
  else if (st.ap[1] < -wd3) st.ap[1] = -wd3;

  wd1 = d === 0 ? 0 : 128;
  st.sg[0] = d >> 15;
  for (let i = 1; i < 7; i += 1) {
    st.sg[i] = st.d[i] >> 15;
    wd2 = st.sg[i] === st.sg[0] ? wd1 : -wd1;
    wd3 = (st.b[i] * 32640) >> 15;
    st.bp[i] = saturate(wd2 + wd3);
  }

  for (let i = 6; i > 0; i -= 1) {
    st.d[i] = st.d[i - 1];
    st.b[i] = st.bp[i];
  }
  for (let i = 2; i > 0; i -= 1) {
    st.r[i] = st.r[i - 1];
    st.p[i] = st.p[i - 1];
    st.a[i] = st.ap[i];
  }

  wd1 = saturate(st.r[1] + st.r[1]);
  wd1 = (st.a[1] * wd1) >> 15;
  wd2 = saturate(st.r[2] + st.r[2]);
  wd2 = (st.a[2] * wd2) >> 15;
  st.sp = saturate(wd1 + wd2);

  st.sz = 0;
  for (let i = 6; i > 0; i -= 1) {
    wd1 = saturate(st.d[i] + st.d[i]);
    st.sz += (st.b[i] * wd1) >> 15;
  }
  st.sz = saturate(st.sz);
  st.s = saturate(st.sp + st.sz);
}

export class G722Decoder {
  private readonly state: G722DecodeState;

  constructor(rate: number = 64000, options: number = 0) {
    this.state = createDecodeState(rate, options);
  }

  decode(data: Buffer): Int16Array {
    const s = this.state;
    const output = new Int16Array(s.eightK ? data.length : data.length * 2);
    let outLen = 0;
    let rhigh = 0;
    let j = 0;

    while (j < data.length) {
      let code: number;
      if (s.packed) {
        if (s.inBits < s.bitsPerSample) {
          s.inBuffer |= data[j] << s.inBits;
          s.inBits += 8;
          j += 1;
        }
        code = s.inBuffer & ((1 << s.bitsPerSample) - 1);
        s.inBuffer >>= s.bitsPerSample;
        s.inBits -= s.bitsPerSample;
      } else {
        code = data[j];
        j += 1;
      }

      let wd1: number;
      let wd2: number;
      let wd3: number;
      let ihigh: number;
      let dlowt: number;
      let rlow: number;
      let dhigh: number;

      switch (s.bitsPerSample) {
        case 7:
          wd1 = code & 0x1f;
          ihigh = (code >> 5) & 0x03;
          wd2 = QM5[wd1];
          wd1 >>= 1;
          break;
        case 6:
          wd1 = code & 0x0f;
          ihigh = (code >> 4) & 0x03;
          wd2 = QM4[wd1];
          break;
        case 8:
        default:
          wd1 = code & 0x3f;
          ihigh = (code >> 6) & 0x03;
          wd2 = QM6[wd1];
          wd1 >>= 2;
          break;
      }

      wd2 = (s.band[0].det * wd2) >> 15;
      rlow = s.band[0].s + wd2;
      if (rlow > 16383) rlow = 16383;
      else if (rlow < -16384) rlow = -16384;

      wd2 = QM4[wd1];
      dlowt = (s.band[0].det * wd2) >> 15;

      wd2 = RL42[wd1];
      wd1 = (s.band[0].nb * 127) >> 7;
      wd1 += WL[wd2];
      if (wd1 < 0) wd1 = 0;
      else if (wd1 > 18432) wd1 = 18432;
      s.band[0].nb = wd1;

      wd1 = (s.band[0].nb >> 6) & 31;
      wd2 = 8 - (s.band[0].nb >> 11);
      wd3 = wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2;
      s.band[0].det = wd3 << 2;

      block4(s, 0, dlowt);

      if (!s.eightK) {
        wd2 = QM2[ihigh];
        dhigh = (s.band[1].det * wd2) >> 15;
        rhigh = dhigh + s.band[1].s;
        if (rhigh > 16383) rhigh = 16383;
        else if (rhigh < -16384) rhigh = -16384;

        wd2 = RH2[ihigh];
        wd1 = (s.band[1].nb * 127) >> 7;
        wd1 += WH[wd2];
        if (wd1 < 0) wd1 = 0;
        else if (wd1 > 22528) wd1 = 22528;
        s.band[1].nb = wd1;

        wd1 = (s.band[1].nb >> 6) & 31;
        wd2 = 10 - (s.band[1].nb >> 11);
        wd3 = wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2;
        s.band[1].det = wd3 << 2;

        block4(s, 1, dhigh);
      }

      if (s.ituTestMode) {
        output[outLen++] = clampInt16(rlow << 1);
        output[outLen++] = clampInt16(rhigh << 1);
      } else if (s.eightK) {
        output[outLen++] = clampInt16(rlow << 1);
      } else {
        for (let i = 0; i < 22; i += 1) {
          s.x[i] = s.x[i + 2];
        }
        s.x[22] = rlow + rhigh;
        s.x[23] = rlow - rhigh;

        let xout1 = 0;
        let xout2 = 0;
        for (let i = 0; i < 12; i += 1) {
          xout2 += s.x[i * 2] * QMF_COEFFS[i];
          xout1 += s.x[i * 2 + 1] * QMF_COEFFS[11 - i];
        }
        output[outLen++] = clampInt16(xout1 >> 11);
        output[outLen++] = clampInt16(xout2 >> 11);
      }
    }

    return output.subarray(0, outLen);
  }
}