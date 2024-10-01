import React from 'react';
import { Main, Room } from './pages';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import WebRTCReact from "./components/WebRtc";

function App() {
    return (
        <WebRTCReact></WebRTCReact>
        // <Router>
        //     <Routes>
        //         <Route path="/" element={<Main />} />
        //         <Route path="/:room" element={<Room />} />
        //     </Routes>
        // </Router>
    );
}

export default App;
