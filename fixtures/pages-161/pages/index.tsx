export async function getServerSideProps() {
  return { props: { hello: "from pages/index (flat)" } };
}

export default function Home({ hello }: { hello: string }) {
  return <main>{hello}</main>;
}
