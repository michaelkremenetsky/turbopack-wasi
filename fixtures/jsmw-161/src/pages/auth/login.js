export async function getServerSideProps() { return { props: { where: "src/pages/auth/login" } }; }
export default function Login({ where }) { return <main>{where}</main>; }
