import artemisPortrait from '../../asset/goddess-artemis-painting-24-3313935094.jpg';

type BrandMarkProps = {
  className?: string;
  size?: number;
};

export default function BrandMark({ className = '', size = 96 }: BrandMarkProps) {
  return (
    <img
      className={className}
      width={size}
      height={size}
      src={artemisPortrait}
      alt="Artemis"
      role="img"
      style={{
        objectFit: 'cover',
        objectPosition: '50% 32%',
        borderRadius: '50%',
      }}
    />
  );
}