import React, { useRef, useState, useEffect } from 'react';
import { io } from "socket.io-client";

const WebRTCReact = () => {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const [localConnection, setLocalConnection] = useState(null);
    const [remoteConnection, setRemoteConnection] = useState(null);
    const [callStatus, setCallStatus] = useState('대기 중');
    const socketRef = useRef(null);
    const offerQueue = useRef([]);
    const answerQueue = useRef([]);
    const candidateQueue = useRef([]);
    const isCallingRef = useRef(false); // 통화 중인지 여부 체크

    // STUN/TURN 서버 설정
    const iceServers = {
        iceServers: [
            { urls: 'stun:hideeer.p-e.kr:3478' },
            {
                urls: 'turn:hideeer.p-e.kr:3478',
                username: "imnotMango",
                credential: "test1234"
            }
        ]
    };

    const connectWebSocket = () => {
        socketRef.current = io('wss://hideeer.p-e.kr:3001', {
            transports: ['websocket'], // 웹소켓을 통한 전송
        });

        socketRef.current.on('connect', () => {
            console.log('WebSocket connection established');
            setCallStatus('연결됨');
        });

        socketRef.current.on('error', (error) => {
            handleError(error);
        });

        socketRef.current.on('disconnect', () => {
            console.log('WebSocket connection closed');
            setCallStatus('WebSocket 연결 종료. 재연결 시도 중...');
            setTimeout(connectWebSocket, 3000);
        });

        socketRef.current.on('offer', (offer) => {
            console.log('Offer received:', offer);
            if (remoteConnection) {
                handleOffer(offer);
            } else {
                offerQueue.current.push(offer);
            }
        });

        socketRef.current.on('answer', (answer) => {
            console.log('Answer received:', answer);
            if (localConnection) {
                handleAnswer(answer);
            } else {
                answerQueue.current.push(answer);
            }
        });

        socketRef.current.on('ice-candidate', (candidate) => {
            console.log('ICE Candidate received:', candidate);
            handleRemoteIceCandidate(candidate);
        });
    };

    const handleError = (error) => {
        console.error(error);
        setCallStatus('오류 발생: ' + error.message); // UI에 오류 메시지 표시
    };

    const startLocalStream = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideoRef.current.srcObject = stream; // 로컬 비디오에 스트림 연결
            return stream;
        } catch (err) {
            handleError(err);
            return null;
        }
    };

    const createPeerConnection = () => {
        const peerConnection = new RTCPeerConnection(iceServers);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('ICE Candidate generated:', event.candidate);
                socketRef.current.emit('ice-candidate', {
                    type: 'ice-candidate',
                    candidate: event.candidate,
                });
            }
        };

        peerConnection.ontrack = (event) => {
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0]; // 원격 비디오에 스트림 연결
                console.log('Received remote stream:', event.streams[0]);
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', peerConnection.iceConnectionState);
            setCallStatus(`ICE 상태: ${peerConnection.iceConnectionState}`); // ICE 상태 UI에 표시

            // 추가: ICE 상태에 따른 로깅
            if (peerConnection.iceConnectionState === 'connected') {
                console.log('ICE 연결이 완료되었습니다.');
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                console.log('ICE 연결이 끊어졌습니다.');
            } else if (peerConnection.iceConnectionState === 'failed') {
                console.error('ICE 연결에 실패했습니다.');
            }
        };

        return peerConnection;
    };


    const startCall = async () => {
        if (isCallingRef.current) return; // 이미 통화 중이면 중지
        isCallingRef.current = true; // 통화 시작

        const localStream = await startLocalStream();
        if (!localStream) return;

        // 기존 연결이 있으면 정리
        if (localConnection) {
            localConnection.close();
            setLocalConnection(null);
        }
        if (remoteConnection) {
            remoteConnection.close();
            setRemoteConnection(null);
        }

        const localPeerConnection = createPeerConnection();
        localStream.getTracks().forEach(track => localPeerConnection.addTrack(track, localStream));
        setLocalConnection(localPeerConnection);

        try {
            const offer = await localPeerConnection.createOffer();
            await localPeerConnection.setLocalDescription(offer);
            socketRef.current.emit('offer', { type: 'offer', sdp: offer.sdp });
            setCallStatus('통화 중');
            console.log('Offer sent:', offer);
        } catch (error) {
            handleError(error);
            isCallingRef.current = false; // 통화 중지
        }

        processOfferQueue();
        processAnswerQueue();
    };

    const handleOffer = async (offer) => {
        const newRemoteConnection = createPeerConnection();
        setRemoteConnection(newRemoteConnection);

        try {
            await newRemoteConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await newRemoteConnection.createAnswer();
            await newRemoteConnection.setLocalDescription(answer);
            socketRef.current.emit('answer', { type: 'answer', sdp: answer.sdp });
            console.log('Answer sent:', answer);
            addCandidatesFromQueue();
        } catch (error) {
            handleError(error);
        }
    };

    const handleAnswer = async (answer) => {
        if (!localConnection) {
            console.error('Local connection is not established');
            setCallStatus('로컬 연결이 설정되지 않았습니다.');
            return;
        }

        // 로컬 연결이 닫힌 경우, 새로운 RTCPeerConnection을 생성
        if (localConnection.connectionState === 'closed') {
            startCall(); // 새로 호출하여 연결 설정
            return;
        }

        try {
            await localConnection.setRemoteDescription(new RTCSessionDescription(answer));
            addCandidatesFromQueue();
        } catch (error) {
            handleError(error);
        }
    };

    const addCandidatesFromQueue = () => {
        if (!remoteConnection || remoteConnection.connectionState === 'closed') return;

        if (candidateQueue.current.length > 0) {
            candidateQueue.current.forEach((candidate) => {
                remoteConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
                    console.error('Error adding ICE candidate from queue:', err);
                });
            });
            candidateQueue.current = [];
        }
    };

    const handleRemoteIceCandidate = (candidate) => {
        if (remoteConnection) {
            remoteConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
                console.error('Error adding ICE candidate:', err);
            });
        } else {
            candidateQueue.current.push(candidate);
        }
    };

    const processOfferQueue = () => {
        while (offerQueue.current.length > 0 && remoteConnection) {
            const offer = offerQueue.current.shift();
            handleOffer(offer);
        }
    };

    const processAnswerQueue = () => {
        while (answerQueue.current.length > 0 && localConnection) {
            const answer = answerQueue.current.shift();
            handleAnswer(answer);
        }
    };

    const stopCall = () => {
        if (localConnection) {
            localConnection.close();
            setLocalConnection(null);
        }
        if (remoteConnection) {
            remoteConnection.close();
            setRemoteConnection(null);
        }
        if (localVideoRef.current && localVideoRef.current.srcObject) {
            const tracks = localVideoRef.current.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            localVideoRef.current.srcObject = null;
        }
        setCallStatus('통화 종료'); // 종료 상태 업데이트
        isCallingRef.current = false; // 통화 중 상태 초기화
    };

    useEffect(() => {
        connectWebSocket();

        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }


            // 로컬 비디오 스트림 중지
            if (localVideoRef.current && localVideoRef.current.srcObject) {
                const tracks = localVideoRef.current.srcObject.getTracks();
                tracks.forEach(track => track.stop());
                localVideoRef.current.srcObject = null;
            }

            if (localConnection) {
                localConnection.close();
                setLocalConnection(null);
            }
            if (remoteConnection) {
                remoteConnection.close();
                setRemoteConnection(null);
            }
        };
    }, []);

    return (
        <div>
            <h1>WebRTC 통화</h1>
            <div>
                <video ref={localVideoRef} autoPlay muted style={{ width: '300px' }} />
                <video ref={remoteVideoRef} autoPlay style={{ width: '300px' }} />
            </div>
            <p>{callStatus}</p>
            <button onClick={startCall} disabled={callStatus === '통화 중'}>통화 시작</button>
            <button onClick={stopCall} disabled={callStatus !== '통화 중'}>통화 종료</button>
        </div>
    );
};

export default WebRTCReact;
