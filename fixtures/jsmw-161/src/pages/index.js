export async function getServerSideProps() { return { props: { hello: "from src/pages/index" } }; }
export default function Home({ hello }) { return <main>{hello}</main>; }
