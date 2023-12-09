export default {
  VoiceWSCloseCodes: {
    4000: 'Unknown error',
    4001: 'Unknown opcode',
    4002: 'Decode error',
    4003: 'Not authenticated',
    4004: 'Authentication failed',
    4005: 'Already authenticated',
    4007: 'Invalid seq',
    4008: 'Rate limited',
    4009: 'Session timed out',
    4010: 'Invalid shard',
    4011: 'Sharding required',
    4012: 'Invalid API version',
    4013: 'Invalid intent(s)',
    4014: 'Disallowed intent(s)'
  },
  opus: {
    samplingRate: 48000,
    frameSize: 960,
    channels: 2
  },
  sampleRate: {
    coefficients: [{
      beta: 0.99847546664,
      alpha: 76226668143e-14,
      gamma: 1.9984647656
    }, {
      beta: 0.99756184654,
      alpha: 0.0012190767289,
      gamma: 1.9975344645
    }, {
      beta: 0.99616261379,
      alpha: 0.0019186931041,
      gamma: 1.9960947369
    }, {
      beta: 0.99391578543,
      alpha: 0.0030421072865,
      gamma: 1.9937449618
    }, {
      beta: 0.99028307215,
      alpha: 0.0048584639242,
      gamma: 1.9898465702
    }, {
      beta: 0.98485897264,
      alpha: 0.0075705136795,
      gamma: 1.9837962543
    }, {
      beta: 0.97588512657,
      alpha: 0.012057436715,
      gamma: 1.9731772447
    }, {
      beta: 0.96228521814,
      alpha: 0.018857390928,
      gamma: 1.9556164694
    }, {
      beta: 0.94080933132,
      alpha: 0.029595334338,
      gamma: 1.9242054384
    }, {
      beta: 0.90702059196,
      alpha: 0.046489704022,
      gamma: 1.8653476166
    }, {
      beta: 0.85868004289,
      alpha: 0.070659978553,
      gamma: 1.7600401337
    }, {
      beta: 0.78409610788,
      alpha: 0.10795194606,
      gamma: 1.5450725522
    }, {
      beta: 0.68332861002,
      alpha: 0.15833569499,
      gamma: 1.1426447155
    }, {
      beta: 0.55267518228,
      alpha: 0.22366240886,
      gamma: 0.40186190803
    }, {
      beta: 0.41811888447,
      alpha: 0.29094055777,
      gamma: -0.70905944223
    }]
  },
  pcm: {
    maximumRate: 32767,
    minimumRate: -32768,
    bits: 16,
    bytes: 2,
    channels: 2
  },
  filtering: {
    equalizerBands: 15,
    types: {
      equalizer: 1,
      tremolo: 2,
      rotationHz: 3,
    }
  },
  circunferece: {
    diameter: 2 * Math.PI
  }
}