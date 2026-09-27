export default function AppLoading(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading Jamee"
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        color: '#526158',
        background: '#f8faf8',
      }}
    >
      Jamee is getting your workspace ready…
    </div>
  );
}
