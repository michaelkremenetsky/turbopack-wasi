export async function getServerSideProps() {
  return { props: { where: "pages/auth/login (flat nested)" } };
}

export default function Login({ where }: { where: string }) {
  return <main>{where}</main>;
}
