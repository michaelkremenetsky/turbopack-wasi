export async function getServerSideProps() {
  return { props: { hello: "from src/pages/index" } };
}

export default function Home({ hello }: { hello: string }) {
  return <main>{hello}</main>;
}
