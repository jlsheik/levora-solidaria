import React, { ComponentType, ReactNode } from "react";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";
import { GlobalContextProviders } from "./components/_globalContextProviders";

import IndexPage from "./pages/_index";
import indexPageLayout from "./pages/_index.pageLayout";
import AccountPage from "./pages/conta";
import accountPageLayout from "./pages/conta.pageLayout";
import SecurityPage from "./pages/seguranca";
import securityPageLayout from "./pages/seguranca.pageLayout";
import PlatformActivatePage from "./pages/plataforma.ativar";
import platformActivatePageLayout from "./pages/plataforma.ativar.pageLayout";

import LoginPage from "./pages/login";
import loginPageLayout from "./pages/login.pageLayout";

import AcceptInvitePage from "./pages/convites.$token";
import acceptInvitePageLayout from "./pages/convites.$token.pageLayout";

import OrganizationDetailPage from "./pages/organizacoes.$organizationId";
import organizationDetailPageLayout from "./pages/organizacoes.$organizationId.pageLayout";

import OrganizationInventoryPage from "./pages/organizacoes.$organizationId.inventario";
import organizationInventoryPageLayout from "./pages/organizacoes.$organizationId.inventario.pageLayout";

import OrganizationNeedsPage from "./pages/organizacoes.$organizationId.necessidades";
import organizationNeedsPageLayout from "./pages/organizacoes.$organizationId.necessidades.pageLayout";

import OrganizationOpportunitiesPage from "./pages/organizacoes.$organizationId.oportunidades";
import organizationOpportunitiesPageLayout from "./pages/organizacoes.$organizationId.oportunidades.pageLayout";

import OrganizationAllocationsPage from "./pages/organizacoes.$organizationId.atribuicoes";
import organizationAllocationsPageLayout from "./pages/organizacoes.$organizationId.atribuicoes.pageLayout";

import OrganizationDestinationsPage from "./pages/organizacoes.$organizationId.destinacoes";
import organizationDestinationsPageLayout from "./pages/organizacoes.$organizationId.destinacoes.pageLayout";
import OrganizationAccountingPage from "./pages/organizacoes.$organizationId.prestacao-contas";
import organizationAccountingPageLayout from "./pages/organizacoes.$organizationId.prestacao-contas.pageLayout";

import OrganizationMatchingSettingsPage from "./pages/organizacoes.$organizationId.matching";
import organizationMatchingSettingsPageLayout from "./pages/organizacoes.$organizationId.matching.pageLayout";
import OrganizationUnitsPage from "./pages/organizacoes.$organizationId.unidades";
import organizationUnitsPageLayout from "./pages/organizacoes.$organizationId.unidades.pageLayout";
import OrganizationRegularizationPage from "./pages/organizacoes.$organizationId.regularizacao";
import organizationRegularizationPageLayout from "./pages/organizacoes.$organizationId.regularizacao.pageLayout";
import OrganizationAutomationPage from "./pages/organizacoes.$organizationId.automacao";
import OrganizationAuditPage from "./pages/organizacoes.$organizationId.auditoria";
import OrganizationJourneyPage from "./pages/organizacoes.$organizationId.jornada";
import organizationJourneyPageLayout from "./pages/organizacoes.$organizationId.jornada.pageLayout";
import organizationAuditPageLayout from "./pages/organizacoes.$organizationId.auditoria.pageLayout";
import organizationAutomationPageLayout from "./pages/organizacoes.$organizationId.automacao.pageLayout";

import PlatformPage from "./pages/plataforma";
import platformPageLayout from "./pages/plataforma.pageLayout";

// Cada pageLayout.tsx portado do Floot exporta um array de componentes de
// ordem superior (ex: [UserRoute], [AdminRoute] ou [] para páginas
// públicas) definidos em components/ProtectedRoute. Esta função os aplica
// em ordem, de fora para dentro, exatamente como o runtime de rotas do
// Floot fazia, sem inventar um novo mecanismo de proteção de rotas.
type LayoutWrapper = ComponentType<{ children: ReactNode }>;

function withPageLayout(layouts: LayoutWrapper[], Page: ComponentType): ReactNode {
  return layouts.reduceRight<ReactNode>(
    (children, Layout) => <Layout>{children}</Layout>,
    <Page />
  );
}

// GlobalContextProviders (query client, tema, auth, toaster) precisa viver
// DENTRO do roteador porque um dos providers (ScrollToHashElement) usa
// useLocation() do react-router — por isso é a rota raiz com <Outlet/>,
// em vez de envolver <App/> por fora em main.tsx.
const router = createBrowserRouter([
  {
    element: (
      <GlobalContextProviders>
        <Outlet />
      </GlobalContextProviders>
    ),
    children: [
      {
        path: "/",
        element: <>{withPageLayout(indexPageLayout, IndexPage)}</>,
      },
      {
        path: "/login",
        element: <>{withPageLayout(loginPageLayout, LoginPage)}</>,
      },
      {
        path: "/convites/:token",
        element: <>{withPageLayout(acceptInvitePageLayout, AcceptInvitePage)}</>,
      },
      {
        path: "/organizacoes/:organizationId",
        element: <>{withPageLayout(organizationDetailPageLayout, OrganizationDetailPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/inventario",
        element: <>{withPageLayout(organizationInventoryPageLayout, OrganizationInventoryPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/necessidades",
        element: <>{withPageLayout(organizationNeedsPageLayout, OrganizationNeedsPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/oportunidades",
        element: <>{withPageLayout(organizationOpportunitiesPageLayout, OrganizationOpportunitiesPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/atribuicoes",
        element: <>{withPageLayout(organizationAllocationsPageLayout, OrganizationAllocationsPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/destinacoes",
        element: <>{withPageLayout(organizationDestinationsPageLayout, OrganizationDestinationsPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/prestacao-contas",
        element: <>{withPageLayout(organizationAccountingPageLayout, OrganizationAccountingPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/matching",
        element: <>{withPageLayout(organizationMatchingSettingsPageLayout, OrganizationMatchingSettingsPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/unidades",
        element: <>{withPageLayout(organizationUnitsPageLayout, OrganizationUnitsPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/regularizacao",
        element: <>{withPageLayout(organizationRegularizationPageLayout, OrganizationRegularizationPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/automacao",
        element: <>{withPageLayout(organizationAutomationPageLayout, OrganizationAutomationPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/jornada",
        element: <>{withPageLayout(organizationJourneyPageLayout, OrganizationJourneyPage)}</>,
      },
      {
        path: "/organizacoes/:organizationId/auditoria",
        element: <>{withPageLayout(organizationAuditPageLayout, OrganizationAuditPage)}</>,
      },
      {
        path: "/conta",
        element: <>{withPageLayout(accountPageLayout, AccountPage)}</>,
      },
      {
        path: "/seguranca",
        element: <>{withPageLayout(securityPageLayout, SecurityPage)}</>,
      },
      {
        path: "/plataforma/ativar",
        element: <>{withPageLayout(platformActivatePageLayout, PlatformActivatePage)}</>,
      },
      {
        path: "/plataforma",
        element: <>{withPageLayout(platformPageLayout, PlatformPage)}</>,
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
