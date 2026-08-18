const WAVE_PATH =
  "M0,0 L12.8,2.5 L25.6,4.9 L38.4,7.3 L51.2,9.4 L64,11.3 L76.8,12.9 L89.6,14.3 L102.4,15.2 L115.2,15.8 L128,16 L140.8,15.8 L153.6,15.2 L166.4,14.3 L179.2,12.9 L192,11.3 L204.8,9.4 L217.6,7.3 L230.4,4.9 L243.2,2.5 L256,0 L268.8,-2.5 L281.6,-4.9 L294.4,-7.3 L307.2,-9.4 L320,-11.3 L332.8,-12.9 L345.6,-14.3 L358.4,-15.2 L371.2,-15.8 L384,-16 L396.8,-15.8 L409.6,-15.2 L422.4,-14.3 L435.2,-12.9 L448,-11.3 L460.8,-9.4 L473.6,-7.3 L486.4,-4.9 L499.2,-2.5 L512,0 L524.8,2.5 L537.6,4.9 L550.4,7.3 L563.2,9.4 L576,11.3 L588.8,12.9 L601.6,14.3 L614.4,15.2 L627.2,15.8 L640,16 L652.8,15.8 L665.6,15.2 L678.4,14.3 L691.2,12.9 L704,11.3 L716.8,9.4 L729.6,7.3 L742.4,4.9 L755.2,2.5 L768,0 L780.8,-2.5 L793.6,-4.9 L806.4,-7.3 L819.2,-9.4 L832,-11.3 L844.8,-12.9 L857.6,-14.3 L870.4,-15.2 L883.2,-15.8 L896,-16 L908.8,-15.8 L921.6,-15.2 L934.4,-14.3 L947.2,-12.9 L960,-11.3 L972.8,-9.4 L985.6,-7.3 L998.4,-4.9 L1011.2,-2.5 L1024,0";

export default function FloodLoadingIcon() {
  return (
    <div className="flood-loader-icon" aria-hidden="true">
      <svg viewBox="0 0 1024 1024" focusable="false">
        <defs>
          <clipPath id="flood-loader-badge-clip">
            <rect width="1024" height="1024" rx="220" />
          </clipPath>
          <linearGradient id="flood-loader-water-fill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#1e9db8" />
            <stop offset="100%" stopColor="#0c5c86" />
          </linearGradient>
          <path id="flood-loader-wave" d={WAVE_PATH} />
        </defs>

        <rect width="1024" height="1024" rx="220" fill="#0e3550" />

        <g clipPath="url(#flood-loader-badge-clip)">
          <g className="flood-loader-static-rings">
            <circle cx="512" cy="512" r="360" />
            <circle cx="512" cy="512" r="270" />
            <circle cx="512" cy="512" r="180" />
            <circle cx="512" cy="512" r="90" />
          </g>

          <circle className="flood-loader-pulse flood-loader-pulse-1" cx="512" cy="512" r="90" />
          <circle className="flood-loader-pulse flood-loader-pulse-2" cx="512" cy="512" r="90" />
          <circle className="flood-loader-pulse flood-loader-pulse-3" cx="512" cy="512" r="90" />
          <circle className="flood-loader-pulse flood-loader-pulse-4" cx="512" cy="512" r="90" />

          <g className="flood-loader-water-rise">
            <g transform="translate(0 560)">
              <g className="flood-loader-wave-scroll">
                <g>
                  <path d={`${WAVE_PATH} L1024,600 L0,600 Z`} fill="url(#flood-loader-water-fill)" />
                  <use
                    href="#flood-loader-wave"
                    fill="none"
                    stroke="#8fe9f2"
                    strokeWidth="7"
                    strokeLinecap="round"
                    opacity="0.85"
                  />
                </g>
                <g transform="translate(1024 0)">
                  <path d={`${WAVE_PATH} L1024,600 L0,600 Z`} fill="url(#flood-loader-water-fill)" />
                  <use
                    href="#flood-loader-wave"
                    fill="none"
                    stroke="#8fe9f2"
                    strokeWidth="7"
                    strokeLinecap="round"
                    opacity="0.85"
                  />
                </g>
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
