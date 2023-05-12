import React from 'react';
import Dom from 'react-dom';
import Index from '../src/index'; // Importez votre composant principal ici

const rootElement = document.getElementById('root');

const renderApp = () => {
  Dom.render(<Index />, rootElement); // Utilisez le composant principal directement
};

renderApp();
//@ts-ignore
if (module.hot) {
  //@ts-ignore
  module.hot.accept('../src/App', () => {
    // Mettez à jour le chemin d'importation
    renderApp();
  });
}
